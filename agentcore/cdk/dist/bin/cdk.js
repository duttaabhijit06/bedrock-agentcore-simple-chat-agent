#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk_stack_1 = require("../lib/cdk-stack");
const agentcore_cdk_1 = require("@aws/agentcore-cdk");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const path = require("path");
const fs = require("fs");
function toEnvironment(target) {
    return {
        account: target.account,
        region: target.region,
    };
}
function sanitize(name) {
    return name.replace(/_/g, '-');
}
function toStackName(projectName, targetName) {
    return `AgentCore-${sanitize(projectName)}-${sanitize(targetName)}`;
}
async function main() {
    // Config root is parent of cdk/ directory. The CLI sets process.cwd() to agentcore/cdk/.
    const configRoot = path.resolve(process.cwd(), '..');
    const configIO = new agentcore_cdk_1.ConfigIO({ baseDir: configRoot });
    const spec = await configIO.readProjectSpec();
    const targets = await configIO.readAWSDeploymentTargets();
    // Extract MCP configuration from project spec.
    // Gateway fields are stored in agentcore.json but may not yet be on the
    // AgentCoreProjectSpec type from @aws/agentcore-cdk, so we read them
    // dynamically and cast the resulting object.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const specAny = spec;
    const mcpSpec = specAny.agentCoreGateways?.length
        ? {
            agentCoreGateways: specAny.agentCoreGateways,
            mcpRuntimeTools: specAny.mcpRuntimeTools,
            unassignedTargets: specAny.unassignedTargets,
        }
        : undefined;
    // Read deployed state for credential ARNs (populated by pre-deploy identity setup)
    let deployedState;
    try {
        deployedState = JSON.parse(fs.readFileSync(path.join(configRoot, '.cli', 'deployed-state.json'), 'utf8'));
    }
    catch {
        // Deployed state may not exist on first deploy
    }
    if (targets.length === 0) {
        throw new Error('No deployment targets configured. Please define targets in agentcore/aws-targets.json');
    }
    const app = new aws_cdk_lib_1.App();
    for (const target of targets) {
        const env = toEnvironment(target);
        const stackName = toStackName(spec.name, target.name);
        // Extract credentials from deployed state for this target
        const targetState = deployedState?.targets;
        const targetResources = targetState?.[target.name]?.resources;
        const credentials = targetResources?.credentials;
        new cdk_stack_1.AgentCoreStack(app, stackName, {
            spec,
            mcpSpec,
            credentials,
            env,
            description: `AgentCore stack for ${spec.name} deployed to ${target.name} (${target.region})`,
            tags: {
                'agentcore:project-name': spec.name,
                'agentcore:target-name': target.name,
            },
        });
    }
    app.synth();
}
main().catch((error) => {
    console.error('AgentCore CDK synthesis failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2RrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vYmluL2Nkay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFDQSxnREFBa0Q7QUFDbEQsc0RBQXdFO0FBQ3hFLDZDQUFvRDtBQUNwRCw2QkFBNkI7QUFDN0IseUJBQXlCO0FBRXpCLFNBQVMsYUFBYSxDQUFDLE1BQTJCO0lBQ2hELE9BQU87UUFDTCxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU87UUFDdkIsTUFBTSxFQUFFLE1BQU0sQ0FBQyxNQUFNO0tBQ3RCLENBQUM7QUFDSixDQUFDO0FBRUQsU0FBUyxRQUFRLENBQUMsSUFBWTtJQUM1QixPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQ2pDLENBQUM7QUFFRCxTQUFTLFdBQVcsQ0FBQyxXQUFtQixFQUFFLFVBQWtCO0lBQzFELE9BQU8sYUFBYSxRQUFRLENBQUMsV0FBVyxDQUFDLElBQUksUUFBUSxDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUM7QUFDdEUsQ0FBQztBQUVELEtBQUssVUFBVSxJQUFJO0lBQ2pCLHlGQUF5RjtJQUN6RixNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNyRCxNQUFNLFFBQVEsR0FBRyxJQUFJLHdCQUFRLENBQUMsRUFBRSxPQUFPLEVBQUUsVUFBVSxFQUFFLENBQUMsQ0FBQztJQUV2RCxNQUFNLElBQUksR0FBRyxNQUFNLFFBQVEsQ0FBQyxlQUFlLEVBQUUsQ0FBQztJQUM5QyxNQUFNLE9BQU8sR0FBRyxNQUFNLFFBQVEsQ0FBQyx3QkFBd0IsRUFBRSxDQUFDO0lBRTFELCtDQUErQztJQUMvQyx3RUFBd0U7SUFDeEUscUVBQXFFO0lBQ3JFLDZDQUE2QztJQUM3Qyw4REFBOEQ7SUFDOUQsTUFBTSxPQUFPLEdBQUcsSUFBVyxDQUFDO0lBQzVCLE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxpQkFBaUIsRUFBRSxNQUFNO1FBQy9DLENBQUMsQ0FBQztZQUNFLGlCQUFpQixFQUFFLE9BQU8sQ0FBQyxpQkFBaUI7WUFDNUMsZUFBZSxFQUFFLE9BQU8sQ0FBQyxlQUFlO1lBQ3hDLGlCQUFpQixFQUFFLE9BQU8sQ0FBQyxpQkFBaUI7U0FDN0M7UUFDSCxDQUFDLENBQUMsU0FBUyxDQUFDO0lBRWQsbUZBQW1GO0lBQ25GLElBQUksYUFBa0QsQ0FBQztJQUN2RCxJQUFJLENBQUM7UUFDSCxhQUFhLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLE1BQU0sRUFBRSxxQkFBcUIsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUM7SUFDNUcsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNQLCtDQUErQztJQUNqRCxDQUFDO0lBRUQsSUFBSSxPQUFPLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3pCLE1BQU0sSUFBSSxLQUFLLENBQUMsdUZBQXVGLENBQUMsQ0FBQztJQUMzRyxDQUFDO0lBRUQsTUFBTSxHQUFHLEdBQUcsSUFBSSxpQkFBRyxFQUFFLENBQUM7SUFFdEIsS0FBSyxNQUFNLE1BQU0sSUFBSSxPQUFPLEVBQUUsQ0FBQztRQUM3QixNQUFNLEdBQUcsR0FBRyxhQUFhLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDbEMsTUFBTSxTQUFTLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBRXRELDBEQUEwRDtRQUMxRCxNQUFNLFdBQVcsR0FBSSxhQUF5QyxFQUFFLE9BRW5ELENBQUM7UUFDZCxNQUFNLGVBQWUsR0FBRyxXQUFXLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsU0FBZ0QsQ0FBQztRQUNyRyxNQUFNLFdBQVcsR0FBRyxlQUFlLEVBQUUsV0FFeEIsQ0FBQztRQUVkLElBQUksMEJBQWMsQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFO1lBQ2pDLElBQUk7WUFDSixPQUFPO1lBQ1AsV0FBVztZQUNYLEdBQUc7WUFDSCxXQUFXLEVBQUUsdUJBQXVCLElBQUksQ0FBQyxJQUFJLGdCQUFnQixNQUFNLENBQUMsSUFBSSxLQUFLLE1BQU0sQ0FBQyxNQUFNLEdBQUc7WUFDN0YsSUFBSSxFQUFFO2dCQUNKLHdCQUF3QixFQUFFLElBQUksQ0FBQyxJQUFJO2dCQUNuQyx1QkFBdUIsRUFBRSxNQUFNLENBQUMsSUFBSTthQUNyQztTQUNGLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCxHQUFHLENBQUMsS0FBSyxFQUFFLENBQUM7QUFDZCxDQUFDO0FBRUQsSUFBSSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBYyxFQUFFLEVBQUU7SUFDOUIsT0FBTyxDQUFDLEtBQUssQ0FBQyxpQ0FBaUMsRUFBRSxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNqRyxPQUFPLENBQUMsUUFBUSxHQUFHLENBQUMsQ0FBQztBQUN2QixDQUFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IG5vZGVcbmltcG9ydCB7IEFnZW50Q29yZVN0YWNrIH0gZnJvbSAnLi4vbGliL2Nkay1zdGFjayc7XG5pbXBvcnQgeyBDb25maWdJTywgdHlwZSBBd3NEZXBsb3ltZW50VGFyZ2V0IH0gZnJvbSAnQGF3cy9hZ2VudGNvcmUtY2RrJztcbmltcG9ydCB7IEFwcCwgdHlwZSBFbnZpcm9ubWVudCB9IGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5cbmZ1bmN0aW9uIHRvRW52aXJvbm1lbnQodGFyZ2V0OiBBd3NEZXBsb3ltZW50VGFyZ2V0KTogRW52aXJvbm1lbnQge1xuICByZXR1cm4ge1xuICAgIGFjY291bnQ6IHRhcmdldC5hY2NvdW50LFxuICAgIHJlZ2lvbjogdGFyZ2V0LnJlZ2lvbixcbiAgfTtcbn1cblxuZnVuY3Rpb24gc2FuaXRpemUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIG5hbWUucmVwbGFjZSgvXy9nLCAnLScpO1xufVxuXG5mdW5jdGlvbiB0b1N0YWNrTmFtZShwcm9qZWN0TmFtZTogc3RyaW5nLCB0YXJnZXROYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYEFnZW50Q29yZS0ke3Nhbml0aXplKHByb2plY3ROYW1lKX0tJHtzYW5pdGl6ZSh0YXJnZXROYW1lKX1gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICAvLyBDb25maWcgcm9vdCBpcyBwYXJlbnQgb2YgY2RrLyBkaXJlY3RvcnkuIFRoZSBDTEkgc2V0cyBwcm9jZXNzLmN3ZCgpIHRvIGFnZW50Y29yZS9jZGsvLlxuICBjb25zdCBjb25maWdSb290ID0gcGF0aC5yZXNvbHZlKHByb2Nlc3MuY3dkKCksICcuLicpO1xuICBjb25zdCBjb25maWdJTyA9IG5ldyBDb25maWdJTyh7IGJhc2VEaXI6IGNvbmZpZ1Jvb3QgfSk7XG5cbiAgY29uc3Qgc3BlYyA9IGF3YWl0IGNvbmZpZ0lPLnJlYWRQcm9qZWN0U3BlYygpO1xuICBjb25zdCB0YXJnZXRzID0gYXdhaXQgY29uZmlnSU8ucmVhZEFXU0RlcGxveW1lbnRUYXJnZXRzKCk7XG5cbiAgLy8gRXh0cmFjdCBNQ1AgY29uZmlndXJhdGlvbiBmcm9tIHByb2plY3Qgc3BlYy5cbiAgLy8gR2F0ZXdheSBmaWVsZHMgYXJlIHN0b3JlZCBpbiBhZ2VudGNvcmUuanNvbiBidXQgbWF5IG5vdCB5ZXQgYmUgb24gdGhlXG4gIC8vIEFnZW50Q29yZVByb2plY3RTcGVjIHR5cGUgZnJvbSBAYXdzL2FnZW50Y29yZS1jZGssIHNvIHdlIHJlYWQgdGhlbVxuICAvLyBkeW5hbWljYWxseSBhbmQgY2FzdCB0aGUgcmVzdWx0aW5nIG9iamVjdC5cbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbiAgY29uc3Qgc3BlY0FueSA9IHNwZWMgYXMgYW55O1xuICBjb25zdCBtY3BTcGVjID0gc3BlY0FueS5hZ2VudENvcmVHYXRld2F5cz8ubGVuZ3RoXG4gICAgPyB7XG4gICAgICAgIGFnZW50Q29yZUdhdGV3YXlzOiBzcGVjQW55LmFnZW50Q29yZUdhdGV3YXlzLFxuICAgICAgICBtY3BSdW50aW1lVG9vbHM6IHNwZWNBbnkubWNwUnVudGltZVRvb2xzLFxuICAgICAgICB1bmFzc2lnbmVkVGFyZ2V0czogc3BlY0FueS51bmFzc2lnbmVkVGFyZ2V0cyxcbiAgICAgIH1cbiAgICA6IHVuZGVmaW5lZDtcblxuICAvLyBSZWFkIGRlcGxveWVkIHN0YXRlIGZvciBjcmVkZW50aWFsIEFSTnMgKHBvcHVsYXRlZCBieSBwcmUtZGVwbG95IGlkZW50aXR5IHNldHVwKVxuICBsZXQgZGVwbG95ZWRTdGF0ZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgZGVwbG95ZWRTdGF0ZSA9IEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKHBhdGguam9pbihjb25maWdSb290LCAnLmNsaScsICdkZXBsb3llZC1zdGF0ZS5qc29uJyksICd1dGY4JykpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBEZXBsb3llZCBzdGF0ZSBtYXkgbm90IGV4aXN0IG9uIGZpcnN0IGRlcGxveVxuICB9XG5cbiAgaWYgKHRhcmdldHMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdObyBkZXBsb3ltZW50IHRhcmdldHMgY29uZmlndXJlZC4gUGxlYXNlIGRlZmluZSB0YXJnZXRzIGluIGFnZW50Y29yZS9hd3MtdGFyZ2V0cy5qc29uJyk7XG4gIH1cblxuICBjb25zdCBhcHAgPSBuZXcgQXBwKCk7XG5cbiAgZm9yIChjb25zdCB0YXJnZXQgb2YgdGFyZ2V0cykge1xuICAgIGNvbnN0IGVudiA9IHRvRW52aXJvbm1lbnQodGFyZ2V0KTtcbiAgICBjb25zdCBzdGFja05hbWUgPSB0b1N0YWNrTmFtZShzcGVjLm5hbWUsIHRhcmdldC5uYW1lKTtcblxuICAgIC8vIEV4dHJhY3QgY3JlZGVudGlhbHMgZnJvbSBkZXBsb3llZCBzdGF0ZSBmb3IgdGhpcyB0YXJnZXRcbiAgICBjb25zdCB0YXJnZXRTdGF0ZSA9IChkZXBsb3llZFN0YXRlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KT8udGFyZ2V0cyBhc1xuICAgICAgfCBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj5cbiAgICAgIHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IHRhcmdldFJlc291cmNlcyA9IHRhcmdldFN0YXRlPy5bdGFyZ2V0Lm5hbWVdPy5yZXNvdXJjZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgY29uc3QgY3JlZGVudGlhbHMgPSB0YXJnZXRSZXNvdXJjZXM/LmNyZWRlbnRpYWxzIGFzXG4gICAgICB8IFJlY29yZDxzdHJpbmcsIHsgY3JlZGVudGlhbFByb3ZpZGVyQXJuOiBzdHJpbmc7IGNsaWVudFNlY3JldEFybj86IHN0cmluZyB9PlxuICAgICAgfCB1bmRlZmluZWQ7XG5cbiAgICBuZXcgQWdlbnRDb3JlU3RhY2soYXBwLCBzdGFja05hbWUsIHtcbiAgICAgIHNwZWMsXG4gICAgICBtY3BTcGVjLFxuICAgICAgY3JlZGVudGlhbHMsXG4gICAgICBlbnYsXG4gICAgICBkZXNjcmlwdGlvbjogYEFnZW50Q29yZSBzdGFjayBmb3IgJHtzcGVjLm5hbWV9IGRlcGxveWVkIHRvICR7dGFyZ2V0Lm5hbWV9ICgke3RhcmdldC5yZWdpb259KWAsXG4gICAgICB0YWdzOiB7XG4gICAgICAgICdhZ2VudGNvcmU6cHJvamVjdC1uYW1lJzogc3BlYy5uYW1lLFxuICAgICAgICAnYWdlbnRjb3JlOnRhcmdldC1uYW1lJzogdGFyZ2V0Lm5hbWUsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXBwLnN5bnRoKCk7XG59XG5cbm1haW4oKS5jYXRjaCgoZXJyb3I6IHVua25vd24pID0+IHtcbiAgY29uc29sZS5lcnJvcignQWdlbnRDb3JlIENESyBzeW50aGVzaXMgZmFpbGVkOicsIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogZXJyb3IpO1xuICBwcm9jZXNzLmV4aXRDb2RlID0gMTtcbn0pO1xuIl19