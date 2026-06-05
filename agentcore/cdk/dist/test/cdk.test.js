"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("aws-cdk-lib");
const assertions_1 = require("aws-cdk-lib/assertions");
const cdk_stack_1 = require("../lib/cdk-stack");
test('AgentCoreStack synthesizes with empty spec', () => {
    const app = new cdk.App();
    const stack = new cdk_stack_1.AgentCoreStack(app, 'TestStack', {
        spec: {
            name: 'testproject',
            version: 1,
            managedBy: 'CDK',
            runtimes: [],
            memories: [],
            credentials: [],
            evaluators: [],
            onlineEvalConfigs: [],
            configBundles: [],
            policyEngines: [],
            agentCoreGateways: [],
            mcpRuntimeTools: [],
            unassignedTargets: [],
        },
    });
    const template = assertions_1.Template.fromStack(stack);
    template.hasOutput('StackNameOutput', {
        Description: 'Name of the CloudFormation Stack',
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2RrLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi90ZXN0L2Nkay50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsbUNBQW1DO0FBQ25DLHVEQUFrRDtBQUNsRCxnREFBa0Q7QUFFbEQsSUFBSSxDQUFDLDRDQUE0QyxFQUFFLEdBQUcsRUFBRTtJQUN0RCxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUMxQixNQUFNLEtBQUssR0FBRyxJQUFJLDBCQUFjLENBQUMsR0FBRyxFQUFFLFdBQVcsRUFBRTtRQUNqRCxJQUFJLEVBQUU7WUFDSixJQUFJLEVBQUUsYUFBYTtZQUNuQixPQUFPLEVBQUUsQ0FBQztZQUNWLFNBQVMsRUFBRSxLQUFjO1lBQ3pCLFFBQVEsRUFBRSxFQUFFO1lBQ1osUUFBUSxFQUFFLEVBQUU7WUFDWixXQUFXLEVBQUUsRUFBRTtZQUNmLFVBQVUsRUFBRSxFQUFFO1lBQ2QsaUJBQWlCLEVBQUUsRUFBRTtZQUNyQixhQUFhLEVBQUUsRUFBRTtZQUNqQixhQUFhLEVBQUUsRUFBRTtZQUNqQixpQkFBaUIsRUFBRSxFQUFFO1lBQ3JCLGVBQWUsRUFBRSxFQUFFO1lBQ25CLGlCQUFpQixFQUFFLEVBQUU7U0FDdEI7S0FDRixDQUFDLENBQUM7SUFDSCxNQUFNLFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUMzQyxRQUFRLENBQUMsU0FBUyxDQUFDLGlCQUFpQixFQUFFO1FBQ3BDLFdBQVcsRUFBRSxrQ0FBa0M7S0FDaEQsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVtcGxhdGUgfSBmcm9tICdhd3MtY2RrLWxpYi9hc3NlcnRpb25zJztcbmltcG9ydCB7IEFnZW50Q29yZVN0YWNrIH0gZnJvbSAnLi4vbGliL2Nkay1zdGFjayc7XG5cbnRlc3QoJ0FnZW50Q29yZVN0YWNrIHN5bnRoZXNpemVzIHdpdGggZW1wdHkgc3BlYycsICgpID0+IHtcbiAgY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgY29uc3Qgc3RhY2sgPSBuZXcgQWdlbnRDb3JlU3RhY2soYXBwLCAnVGVzdFN0YWNrJywge1xuICAgIHNwZWM6IHtcbiAgICAgIG5hbWU6ICd0ZXN0cHJvamVjdCcsXG4gICAgICB2ZXJzaW9uOiAxLFxuICAgICAgbWFuYWdlZEJ5OiAnQ0RLJyBhcyBjb25zdCxcbiAgICAgIHJ1bnRpbWVzOiBbXSxcbiAgICAgIG1lbW9yaWVzOiBbXSxcbiAgICAgIGNyZWRlbnRpYWxzOiBbXSxcbiAgICAgIGV2YWx1YXRvcnM6IFtdLFxuICAgICAgb25saW5lRXZhbENvbmZpZ3M6IFtdLFxuICAgICAgY29uZmlnQnVuZGxlczogW10sXG4gICAgICBwb2xpY3lFbmdpbmVzOiBbXSxcbiAgICAgIGFnZW50Q29yZUdhdGV3YXlzOiBbXSxcbiAgICAgIG1jcFJ1bnRpbWVUb29sczogW10sXG4gICAgICB1bmFzc2lnbmVkVGFyZ2V0czogW10sXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgdGVtcGxhdGUuaGFzT3V0cHV0KCdTdGFja05hbWVPdXRwdXQnLCB7XG4gICAgRGVzY3JpcHRpb246ICdOYW1lIG9mIHRoZSBDbG91ZEZvcm1hdGlvbiBTdGFjaycsXG4gIH0pO1xufSk7XG4iXX0=