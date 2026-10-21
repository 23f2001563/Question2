const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { calculateDigest, generateHex } = require('./utils');

const app = express();
app.use(express.json({ limit: '768kb' }));

// In-memory store for runs. 
// NOTE: For Render Free Tier, instances spin down and memory is wiped. 
// If the grader tests persistence over a long period, swap this Map for a local SQLite file.
const runs = new Map(); 

// --- LLM Planner Mock ---
async function runModelPlanner(incident, catalog) {
    // TODO: Implement your actual LLM call here (OpenAI, Gemini, local AI).
    // MUST NOT receive the "sensitive" object.
    
    // Mock response based on exact contract:
    return {
        rootCause: incident.allowedRootCauses[0],
        evidence: ["[ev_123]", "[ev_456]"],
        diagnosticsToRun: [
            { toolName: "query_metrics", arguments: { "metric": "cpu" } }
        ]
    };
}

// --- Route: Start Run ---
app.post('/v2/incidents', async (req, res) => {
    const data = req.body;
    
    // Validate profile
    if (data.profile !== "ga5-incident-agent/v2") {
        return res.status(400).json({ error: "Unsupported profile" });
    }

    const runId = data.runId;
    
    // Replay / Conflict check
    if (runs.has(runId)) {
        const existing = runs.get(runId);
        // If content changed on replay, return 409
        if (existing.originalBodyHash !== calculateDigest(data)) {
            return res.status(409).json({ error: "Conflict: Content changed" });
        }
        return res.json(existing.state);
    }

    // Call Model Planner
    const plan = await runModelPlanner(data.incident, data.toolCatalog);

    // Setup trace context
    const traceId = generateHex(16);
    const agentSpanId = generateHex(8);
    
    // Setup initial state
    const state = {
        runId: runId,
        status: "waiting",
        diagnosis: {
            rootCause: plan.rootCause,
            evidence: plan.evidence
        },
        dispatches: [],
        approvals: [],
        suppressed: [],
        actionLog: [],
        receiptLog: [],
        // Internal metadata for building trace later (do not expose to client yet)
        _meta: {
            traceId: traceId,
            agentSpanId: agentSpanId,
            publicMarker: data.publicMarker,
            policy: data.policy,
            catalog: data.toolCatalog
        }
    };

    // Create Diagnostic Dispatches
    plan.diagnosticsToRun.forEach((diag, index) => {
        const actionId = `act_${generateHex(6)}`;
        const callId = `call_${generateHex(6)}`;
        const spanId = generateHex(8);
        
        const dispatch = {
            actionId: actionId,
            callId: callId,
            phase: "diagnostic",
            toolName: diag.toolName,
            arguments: diag.arguments,
            evidence: [plan.evidence[index % plan.evidence.length]], 
            attempt: 1,
            traceparent: `00-${traceId}-${spanId}-01`
        };
        state.dispatches.push(dispatch);
        state.actionLog.push({ ...dispatch }); // Deep copy for exact log
    });

    runs.set(runId, {
        originalBodyHash: calculateDigest(data),
        state: state
    });

    // Strip internal _meta before sending
    const { _meta, actionLog, receiptLog, ...clientState } = state;
    return res.json(clientState);
});


// --- Route: Process Receipts ---
app.post('/v2/incidents/:runId/receipts', (req, res) => {
    const runId = req.params.runId;
    const body = req.body;
    
    if (!runs.has(runId)) {
        return res.status(404).json({ error: "Run not found" });
    }

    let { state } = runs.get(runId);
    
    // If already terminal, handle replay or reject
    if (state.status === "completed" || state.status === "failed") {
        return res.json(state);
    }

    // Handle grader outcomes (Tool results)
    if (body.outcomes) {
        body.outcomes.forEach(outcome => {
            state.receiptLog.push(outcome);
            
            // Remove from pending dispatches
            const dispatchIndex = state.dispatches.findIndex(d => d.callId === outcome.callId);
            if (dispatchIndex > -1) {
                const dispatch = state.dispatches[dispatchIndex];
                state.dispatches.splice(dispatchIndex, 1);

                // Handle Retries
                if (outcome.status === 503 && dispatch.attempt === 1) {
                    const newSpanId = generateHex(8);
                    const retryDispatch = {
                        ...dispatch,
                        attempt: 2,
                        traceparent: `00-${state._meta.traceId}-${newSpanId}-01`
                    };
                    state.dispatches.push(retryDispatch);
                    state.actionLog.push({ ...retryDispatch });
                }
                // Handle Timeouts
                else if (outcome.status === 0 && outcome.errorType === "timeout") {
                    state.status = "failed"; // Fails the sequence
                }
            }
        });
    }

    // Handle Approvals
    if (body.approvals) {
        body.approvals.forEach(approvalReceipt => {
            state.receiptLog.push(approvalReceipt);
            
            // Remove from pending approvals
            const approvalIndex = state.approvals.findIndex(a => a.approvalId === approvalReceipt.approvalId);
            if (approvalIndex > -1) {
                const approval = state.approvals[approvalIndex];
                state.approvals.splice(approvalIndex, 1);

                if (approvalReceipt.decision === "approved") {
                    // Dispatch the actual destructive effect
                    const spanId = generateHex(8);
                    const effectDispatch = {
                        actionId: approval.actionId,
                        callId: `call_${generateHex(6)}`,
                        phase: "effect",
                        toolName: approval.toolName,
                        arguments: approval._originalArgs, // Stored internally when approval was made
                        attempt: 1,
                        traceparent: `00-${state._meta.traceId}-${spanId}-01`
                    };
                    state.dispatches.push(effectDispatch);
                    state.actionLog.push({ ...effectDispatch });
                }
            }
        });
    }

    // State Transition: Move to Effect / Terminal state if diagnostics are done
    if (state.dispatches.length === 0 && state.approvals.length === 0 && state.status === "waiting") {
        
        // TODO: Logic to decide the final effect based on diagnostics.
        // For scaffolding, we mock a safe effect:
        const chosenEffect = "scale_service"; 
        
        // Check if effect requires approval
        if (state._meta.policy.approvalRequiredFor.includes(chosenEffect)) {
            const effectArgs = { "target": "prod" };
            state.approvals.push({
                approvalId: `appr_${generateHex(6)}`,
                actionId: `act_${generateHex(6)}`,
                toolName: chosenEffect,
                argumentsDigest: calculateDigest(effectArgs),
                _originalArgs: effectArgs // Keep internal for post-approval dispatch
            });
        } else {
            // Finalize
            state.status = "completed";
            state.chosenEffect = chosenEffect;
            state.otlp = generateOTLP(state); // Build final trace
            delete state._meta; // Clean up internal data
        }
    }

    // Return current state. If not terminal, omit actionLog and receiptLog per contract.
    if (state.status === "completed" || state.status === "failed") {
        return res.json(state);
    } else {
        const { _meta, actionLog, receiptLog, ...clientState } = state;
        // Strip internal _originalArgs from approvals before sending
        clientState.approvals = clientState.approvals.map(({_originalArgs, ...a}) => a);
        return res.json(clientState);
    }
});


// --- Route: Get Run ---
app.get('/v2/incidents/:runId', (req, res) => {
    const runId = req.params.runId;
    if (!runs.has(runId)) {
        return res.status(404).json({ error: "Run not found" });
    }
    
    const { state } = runs.get(runId);
    
    if (state.status === "completed" || state.status === "failed") {
        return res.json(state);
    } else {
        const { _meta, actionLog, receiptLog, ...clientState } = state;
        clientState.approvals = clientState.approvals.map(({_originalArgs, ...a}) => a);
        return res.json(clientState);
    }
});


// --- Trace Generator ---
function generateOTLP(state) {
    const { traceId, agentSpanId, publicMarker } = state._meta;
    
    // Base attributes required on all spans
    const baseAttributes = [
        { key: "ga5.run.id", value: { stringValue: state.runId } },
        { key: "ga5.public.marker", value: { stringValue: publicMarker } }
    ];

    // Root Server Span
    const serverSpan = {
        traceId: traceId,
        spanId: generateHex(8),
        name: "incident-response-server",
        kind: 2, // SERVER
        attributes: [...baseAttributes]
    };

    // Agent Span (INTERNAL)
    const agentSpan = {
        traceId: traceId,
        spanId: agentSpanId,
        parentSpanId: serverSpan.spanId,
        name: "invoke_agent",
        kind: 1, // INTERNAL
        attributes: [...baseAttributes]
    };

    // LLM Chat Span (CLIENT)
    const chatSpan = {
        traceId: traceId,
        spanId: generateHex(8),
        parentSpanId: agentSpanId,
        name: "incident-plan",
        kind: 3, // CLIENT
        attributes: [
            ...baseAttributes,
            { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
            { key: "gen_ai.request.model", value: { stringValue: "your-model-name" } }
        ]
    };

    const spans = [serverSpan, agentSpan, chatSpan];

    // Add tool spans based on actionLog
    // Note: A complete implementation requires nesting HTTP client spans inside logical execute_tool spans,
    // handling incident.join for parallel tools, and approval_gate spans.
    state.actionLog.forEach(action => {
        const toolSpan = {
            traceId: traceId,
            spanId: generateHex(8),
            parentSpanId: agentSpanId,
            name: `execute_tool`,
            kind: 1,
            attributes: [
                ...baseAttributes,
                { key: "ga5.action.id", value: { stringValue: action.actionId } },
                { key: "gen_ai.tool.name", value: { stringValue: action.toolName } },
                { key: "gen_ai.tool.call.id", value: { stringValue: action.callId } },
                { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } }
            ]
        };
        spans.push(toolSpan);
    });

    return {
        resourceSpans: [{
            scopeSpans: [{
                spans: spans
            }]
        }]
    };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GA5 Incident Agent running on port ${PORT}`);
});
