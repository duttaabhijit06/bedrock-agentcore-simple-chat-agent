"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentCoreStack = void 0;
const agentcore_cdk_1 = require("@aws/agentcore-cdk");
const aws_cdk_lib_1 = require("aws-cdk-lib");
/**
 * CDK Stack that deploys AgentCore infrastructure.
 *
 * This is a thin wrapper that instantiates L3 constructs.
 * All resource logic and outputs are contained within the L3 constructs.
 */
class AgentCoreStack extends aws_cdk_lib_1.Stack {
    /** The AgentCore application containing all agent environments */
    application;
    constructor(scope, id, props) {
        super(scope, id, props);
        const { spec, mcpSpec, credentials } = props;
        // Create AgentCoreApplication with all agents
        this.application = new agentcore_cdk_1.AgentCoreApplication(this, 'Application', {
            spec,
        });
        // Create AgentCoreMcp if there are gateways configured
        if (mcpSpec?.agentCoreGateways && mcpSpec.agentCoreGateways.length > 0) {
            new agentcore_cdk_1.AgentCoreMcp(this, 'Mcp', {
                projectName: spec.name,
                mcpSpec,
                agentCoreApplication: this.application,
                credentials,
                projectTags: spec.tags,
            });
        }
        // Stack-level output
        new aws_cdk_lib_1.CfnOutput(this, 'StackNameOutput', {
            description: 'Name of the CloudFormation Stack',
            value: this.stackName,
        });
    }
}
exports.AgentCoreStack = AgentCoreStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2RrLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vbGliL2Nkay1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxzREFLNEI7QUFDNUIsNkNBQWdFO0FBa0JoRTs7Ozs7R0FLRztBQUNILE1BQWEsY0FBZSxTQUFRLG1CQUFLO0lBQ3ZDLGtFQUFrRTtJQUNsRCxXQUFXLENBQXVCO0lBRWxELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBMEI7UUFDbEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsV0FBVyxFQUFFLEdBQUcsS0FBSyxDQUFDO1FBRTdDLDhDQUE4QztRQUM5QyxJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksb0NBQW9CLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUMvRCxJQUFJO1NBQ0wsQ0FBQyxDQUFDO1FBRUgsdURBQXVEO1FBQ3ZELElBQUksT0FBTyxFQUFFLGlCQUFpQixJQUFJLE9BQU8sQ0FBQyxpQkFBaUIsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDdkUsSUFBSSw0QkFBWSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7Z0JBQzVCLFdBQVcsRUFBRSxJQUFJLENBQUMsSUFBSTtnQkFDdEIsT0FBTztnQkFDUCxvQkFBb0IsRUFBRSxJQUFJLENBQUMsV0FBVztnQkFDdEMsV0FBVztnQkFDWCxXQUFXLEVBQUUsSUFBSSxDQUFDLElBQUk7YUFDdkIsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztRQUVELHFCQUFxQjtRQUNyQixJQUFJLHVCQUFTLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQ3JDLFdBQVcsRUFBRSxrQ0FBa0M7WUFDL0MsS0FBSyxFQUFFLElBQUksQ0FBQyxTQUFTO1NBQ3RCLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQS9CRCx3Q0ErQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICBBZ2VudENvcmVBcHBsaWNhdGlvbixcbiAgQWdlbnRDb3JlTWNwLFxuICB0eXBlIEFnZW50Q29yZVByb2plY3RTcGVjLFxuICB0eXBlIEFnZW50Q29yZU1jcFNwZWMsXG59IGZyb20gJ0Bhd3MvYWdlbnRjb3JlLWNkayc7XG5pbXBvcnQgeyBDZm5PdXRwdXQsIFN0YWNrLCB0eXBlIFN0YWNrUHJvcHMgfSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBBZ2VudENvcmVTdGFja1Byb3BzIGV4dGVuZHMgU3RhY2tQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgQWdlbnRDb3JlIHByb2plY3Qgc3BlY2lmaWNhdGlvbiBjb250YWluaW5nIGFnZW50cywgbWVtb3JpZXMsIGFuZCBjcmVkZW50aWFscy5cbiAgICovXG4gIHNwZWM6IEFnZW50Q29yZVByb2plY3RTcGVjO1xuICAvKipcbiAgICogVGhlIE1DUCBzcGVjaWZpY2F0aW9uIGNvbnRhaW5pbmcgZ2F0ZXdheXMgYW5kIHNlcnZlcnMuXG4gICAqL1xuICBtY3BTcGVjPzogQWdlbnRDb3JlTWNwU3BlYztcbiAgLyoqXG4gICAqIENyZWRlbnRpYWwgcHJvdmlkZXIgQVJOcyBmcm9tIGRlcGxveWVkIHN0YXRlLCBrZXllZCBieSBjcmVkZW50aWFsIG5hbWUuXG4gICAqL1xuICBjcmVkZW50aWFscz86IFJlY29yZDxzdHJpbmcsIHsgY3JlZGVudGlhbFByb3ZpZGVyQXJuOiBzdHJpbmc7IGNsaWVudFNlY3JldEFybj86IHN0cmluZyB9Pjtcbn1cblxuLyoqXG4gKiBDREsgU3RhY2sgdGhhdCBkZXBsb3lzIEFnZW50Q29yZSBpbmZyYXN0cnVjdHVyZS5cbiAqXG4gKiBUaGlzIGlzIGEgdGhpbiB3cmFwcGVyIHRoYXQgaW5zdGFudGlhdGVzIEwzIGNvbnN0cnVjdHMuXG4gKiBBbGwgcmVzb3VyY2UgbG9naWMgYW5kIG91dHB1dHMgYXJlIGNvbnRhaW5lZCB3aXRoaW4gdGhlIEwzIGNvbnN0cnVjdHMuXG4gKi9cbmV4cG9ydCBjbGFzcyBBZ2VudENvcmVTdGFjayBleHRlbmRzIFN0YWNrIHtcbiAgLyoqIFRoZSBBZ2VudENvcmUgYXBwbGljYXRpb24gY29udGFpbmluZyBhbGwgYWdlbnQgZW52aXJvbm1lbnRzICovXG4gIHB1YmxpYyByZWFkb25seSBhcHBsaWNhdGlvbjogQWdlbnRDb3JlQXBwbGljYXRpb247XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFnZW50Q29yZVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IHsgc3BlYywgbWNwU3BlYywgY3JlZGVudGlhbHMgfSA9IHByb3BzO1xuXG4gICAgLy8gQ3JlYXRlIEFnZW50Q29yZUFwcGxpY2F0aW9uIHdpdGggYWxsIGFnZW50c1xuICAgIHRoaXMuYXBwbGljYXRpb24gPSBuZXcgQWdlbnRDb3JlQXBwbGljYXRpb24odGhpcywgJ0FwcGxpY2F0aW9uJywge1xuICAgICAgc3BlYyxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBBZ2VudENvcmVNY3AgaWYgdGhlcmUgYXJlIGdhdGV3YXlzIGNvbmZpZ3VyZWRcbiAgICBpZiAobWNwU3BlYz8uYWdlbnRDb3JlR2F0ZXdheXMgJiYgbWNwU3BlYy5hZ2VudENvcmVHYXRld2F5cy5sZW5ndGggPiAwKSB7XG4gICAgICBuZXcgQWdlbnRDb3JlTWNwKHRoaXMsICdNY3AnLCB7XG4gICAgICAgIHByb2plY3ROYW1lOiBzcGVjLm5hbWUsXG4gICAgICAgIG1jcFNwZWMsXG4gICAgICAgIGFnZW50Q29yZUFwcGxpY2F0aW9uOiB0aGlzLmFwcGxpY2F0aW9uLFxuICAgICAgICBjcmVkZW50aWFscyxcbiAgICAgICAgcHJvamVjdFRhZ3M6IHNwZWMudGFncyxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIFN0YWNrLWxldmVsIG91dHB1dFxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ1N0YWNrTmFtZU91dHB1dCcsIHtcbiAgICAgIGRlc2NyaXB0aW9uOiAnTmFtZSBvZiB0aGUgQ2xvdWRGb3JtYXRpb24gU3RhY2snLFxuICAgICAgdmFsdWU6IHRoaXMuc3RhY2tOYW1lLFxuICAgIH0pO1xuICB9XG59XG4iXX0=