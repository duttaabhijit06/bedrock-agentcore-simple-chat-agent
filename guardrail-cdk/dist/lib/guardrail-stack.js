"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GuardrailStack = void 0;
const cdk = require("aws-cdk-lib");
const bedrock = require("aws-cdk-lib/aws-bedrock");
/**
 * Bedrock Guardrail Stack for Party Supply Chat Agent
 *
 * Creates a guardrail with:
 * - Content filters (LOW/MEDIUM sensitivity to avoid false positives)
 * - Denied topics (Competitors, Politics, Medical/Legal advice)
 * - PII protection (credit cards blocked, emails/phones anonymized)
 *
 * Note: Religious content is NOT blocked since party supplies include religious occasions
 * (Christmas, Hanukkah, Easter, Diwali, Eid, etc.)
 *
 * LEARNINGS:
 * 1. Topic definitions have a max length limit - keep them concise
 * 2. Topic detection can trigger false positives on unrelated queries (e.g., "christmas"
 *    triggered "Competitors" topic). Be very specific in definitions and list explicit
 *    company names rather than broad categories.
 * 3. Content filters at HIGH sensitivity block legitimate party supply queries
 *    (e.g., Halloween themes trigger VIOLENCE). Use LOW for retail/e-commerce use cases.
 * 4. The runtime role needs bedrock:ApplyGuardrail and bedrock:GetGuardrail permissions
 *    to use guardrails - add this in deploy.sh step_agent.
 * 5. Guardrail updates only modify DRAFT version. To deploy changes, create a new
 *    CfnGuardrailVersion (change description to force CloudFormation replacement).
 * 6. After creating a new version, update GUARDRAIL_VERSION env var in agentcore.json
 *    and redeploy the agent.
 */
class GuardrailStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const guardrail = new bedrock.CfnGuardrail(this, "PartySupplyGuardrail", {
            name: "PartySupplyGuardrail",
            description: "Content filtering for party supply chat agent - allows religious occasions",
            blockedInputMessaging: "I'm sorry, I can't help with that request. Let me know if you have questions about party supplies!",
            blockedOutputsMessaging: "I'm sorry, I can't provide that information. Is there anything else about party supplies I can help with?",
            // Content filters - use LOW sensitivity to avoid blocking legitimate party supply queries
            // Party supplies include themes like Halloween (violence imagery), weddings (romance), etc.
            contentPolicyConfig: {
                filtersConfig: [
                    { type: "HATE", inputStrength: "HIGH", outputStrength: "HIGH" },
                    { type: "INSULTS", inputStrength: "LOW", outputStrength: "LOW" },
                    { type: "SEXUAL", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
                    { type: "VIOLENCE", inputStrength: "LOW", outputStrength: "LOW" },
                    { type: "MISCONDUCT", inputStrength: "LOW", outputStrength: "LOW" },
                ],
            },
            // Denied topics - keep agent focused on party supplies
            // Note: Religious topics are NOT denied since products include religious occasions
            topicPolicyConfig: {
                topicsConfig: [
                    {
                        name: "Competitors",
                        definition: "Mentions of competitor names: Party City, Amazon, Walmart, Target, Oriental Trading, or price comparisons with other stores",
                        type: "DENY",
                        examples: [
                            "What about Party City?",
                            "Is Amazon cheaper?",
                            "Buy from Oriental Trading",
                            "Compare to Walmart",
                        ],
                    },
                    {
                        name: "Politics",
                        definition: "Political discussions, candidates, elections, political parties, or politically divisive topics",
                        type: "DENY",
                        examples: [
                            "What do you think about the election?",
                            "Which political party is better?",
                            "Should I vote for candidate X?",
                        ],
                    },
                    {
                        name: "MedicalAdvice",
                        definition: "Medical advice, health diagnoses, or treatment recommendations",
                        type: "DENY",
                        examples: [
                            "Is this balloon latex safe for my allergy?",
                            "Can eating cake decorations make you sick?",
                            "What medicine should I take?",
                        ],
                    },
                    {
                        name: "LegalAdvice",
                        definition: "Legal advice, contract interpretation, or liability guidance",
                        type: "DENY",
                        examples: [
                            "Can I sue if someone chokes on confetti?",
                            "Is it legal to use fireworks at my party?",
                            "What are my rights if the order is late?",
                        ],
                    },
                ],
            },
            // Sensitive information filters - protect PII
            sensitiveInformationPolicyConfig: {
                piiEntitiesConfig: [
                    { type: "CREDIT_DEBIT_CARD_NUMBER", action: "BLOCK" },
                    { type: "CREDIT_DEBIT_CARD_CVV", action: "BLOCK" },
                    { type: "CREDIT_DEBIT_CARD_EXPIRY", action: "BLOCK" },
                    { type: "US_SOCIAL_SECURITY_NUMBER", action: "BLOCK" },
                    { type: "US_BANK_ACCOUNT_NUMBER", action: "BLOCK" },
                    { type: "US_BANK_ROUTING_NUMBER", action: "BLOCK" },
                    { type: "EMAIL", action: "ANONYMIZE" },
                    { type: "PHONE", action: "ANONYMIZE" },
                    { type: "NAME", action: "ANONYMIZE" },
                    { type: "ADDRESS", action: "ANONYMIZE" },
                ],
            },
        });
        // Create guardrail version for production use
        // Description change forces a new version on each deployment
        const guardrailVersion = new bedrock.CfnGuardrailVersion(this, "PartySupplyGuardrailVersion", {
            guardrailIdentifier: guardrail.attrGuardrailId,
            description: "v3 - Fixed Competitors topic false positives",
        });
        // Store for reference
        this.guardrailId = guardrail.attrGuardrailId;
        this.guardrailVersion = guardrailVersion.attrVersion;
        this.guardrailArn = guardrail.attrGuardrailArn;
        // Outputs
        new cdk.CfnOutput(this, "GuardrailId", {
            description: "Bedrock Guardrail ID",
            value: guardrail.attrGuardrailId,
            exportName: "PartySupply-GuardrailId",
        });
        new cdk.CfnOutput(this, "GuardrailVersion", {
            description: "Bedrock Guardrail Version",
            value: guardrailVersion.attrVersion,
            exportName: "PartySupply-GuardrailVersion",
        });
        new cdk.CfnOutput(this, "GuardrailArn", {
            description: "Bedrock Guardrail ARN",
            value: guardrail.attrGuardrailArn,
            exportName: "PartySupply-GuardrailArn",
        });
    }
}
exports.GuardrailStack = GuardrailStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ3VhcmRyYWlsLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vbGliL2d1YXJkcmFpbC1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMsbURBQW1EO0FBR25EOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F3Qkc7QUFDSCxNQUFhLGNBQWUsU0FBUSxHQUFHLENBQUMsS0FBSztJQUszQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sU0FBUyxHQUFHLElBQUksT0FBTyxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLEVBQUU7WUFDdkUsSUFBSSxFQUFFLHNCQUFzQjtZQUM1QixXQUFXLEVBQ1QsNEVBQTRFO1lBQzlFLHFCQUFxQixFQUNuQixvR0FBb0c7WUFDdEcsdUJBQXVCLEVBQ3JCLDJHQUEyRztZQUU3RywwRkFBMEY7WUFDMUYsNEZBQTRGO1lBQzVGLG1CQUFtQixFQUFFO2dCQUNuQixhQUFhLEVBQUU7b0JBQ2IsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLGFBQWEsRUFBRSxNQUFNLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRTtvQkFDL0QsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsY0FBYyxFQUFFLEtBQUssRUFBRTtvQkFDaEUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLGFBQWEsRUFBRSxRQUFRLEVBQUUsY0FBYyxFQUFFLFFBQVEsRUFBRTtvQkFDckUsRUFBRSxJQUFJLEVBQUUsVUFBVSxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsY0FBYyxFQUFFLEtBQUssRUFBRTtvQkFDakUsRUFBRSxJQUFJLEVBQUUsWUFBWSxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsY0FBYyxFQUFFLEtBQUssRUFBRTtpQkFD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RUFBRTtZQUMxQyxXQUFXLEVBQUUsMkJBQTJCO1lBQ3hDLEtBQUssRUFBRSxnQkFBZ0IsQ0FBQyxXQUFXO1lBQ25DLFVBQVUsRUFBRSw4QkFBOEI7U0FDM0MsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDdEMsV0FBVyxFQUFFLHVCQUF1QjtZQUNwQyxLQUFLLEVBQUUsU0FBUyxDQUFDLGdCQUFnQjtZQUNqQyxVQUFVLEVBQUUsMEJBQTBCO1NBQ3ZDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXJJRCx3Q0FxSUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBiZWRyb2NrIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYmVkcm9ja1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuLyoqXG4gKiBCZWRyb2NrIEd1YXJkcmFpbCBTdGFjayBmb3IgUGFydHkgU3VwcGx5IENoYXQgQWdlbnRcbiAqXG4gKiBDcmVhdGVzIGEgZ3VhcmRyYWlsIHdpdGg6XG4gKiAtIENvbnRlbnQgZmlsdGVycyAoTE9XL01FRElVTSBzZW5zaXRpdml0eSB0byBhdm9pZCBmYWxzZSBwb3NpdGl2ZXMpXG4gKiAtIERlbmllZCB0b3BpY3MgKENvbXBldGl0b3JzLCBQb2xpdGljcywgTWVkaWNhbC9MZWdhbCBhZHZpY2UpXG4gKiAtIFBJSSBwcm90ZWN0aW9uIChjcmVkaXQgY2FyZHMgYmxvY2tlZCwgZW1haWxzL3Bob25lcyBhbm9ueW1pemVkKVxuICpcbiAqIE5vdGU6IFJlbGlnaW91cyBjb250ZW50IGlzIE5PVCBibG9ja2VkIHNpbmNlIHBhcnR5IHN1cHBsaWVzIGluY2x1ZGUgcmVsaWdpb3VzIG9jY2FzaW9uc1xuICogKENocmlzdG1hcywgSGFudWtrYWgsIEVhc3RlciwgRGl3YWxpLCBFaWQsIGV0Yy4pXG4gKlxuICogTEVBUk5JTkdTOlxuICogMS4gVG9waWMgZGVmaW5pdGlvbnMgaGF2ZSBhIG1heCBsZW5ndGggbGltaXQgLSBrZWVwIHRoZW0gY29uY2lzZVxuICogMi4gVG9waWMgZGV0ZWN0aW9uIGNhbiB0cmlnZ2VyIGZhbHNlIHBvc2l0aXZlcyBvbiB1bnJlbGF0ZWQgcXVlcmllcyAoZS5nLiwgXCJjaHJpc3RtYXNcIlxuICogICAgdHJpZ2dlcmVkIFwiQ29tcGV0aXRvcnNcIiB0b3BpYykuIEJlIHZlcnkgc3BlY2lmaWMgaW4gZGVmaW5pdGlvbnMgYW5kIGxpc3QgZXhwbGljaXRcbiAqICAgIGNvbXBhbnkgbmFtZXMgcmF0aGVyIHRoYW4gYnJvYWQgY2F0ZWdvcmllcy5cbiAqIDMuIENvbnRlbnQgZmlsdGVycyBhdCBISUdIIHNlbnNpdGl2aXR5IGJsb2NrIGxlZ2l0aW1hdGUgcGFydHkgc3VwcGx5IHF1ZXJpZXNcbiAqICAgIChlLmcuLCBIYWxsb3dlZW4gdGhlbWVzIHRyaWdnZXIgVklPTEVOQ0UpLiBVc2UgTE9XIGZvciByZXRhaWwvZS1jb21tZXJjZSB1c2UgY2FzZXMuXG4gKiA0LiBUaGUgcnVudGltZSByb2xlIG5lZWRzIGJlZHJvY2s6QXBwbHlHdWFyZHJhaWwgYW5kIGJlZHJvY2s6R2V0R3VhcmRyYWlsIHBlcm1pc3Npb25zXG4gKiAgICB0byB1c2UgZ3VhcmRyYWlscyAtIGFkZCB0aGlzIGluIGRlcGxveS5zaCBzdGVwX2FnZW50LlxuICogNS4gR3VhcmRyYWlsIHVwZGF0ZXMgb25seSBtb2RpZnkgRFJBRlQgdmVyc2lvbi4gVG8gZGVwbG95IGNoYW5nZXMsIGNyZWF0ZSBhIG5ld1xuICogICAgQ2ZuR3VhcmRyYWlsVmVyc2lvbiAoY2hhbmdlIGRlc2NyaXB0aW9uIHRvIGZvcmNlIENsb3VkRm9ybWF0aW9uIHJlcGxhY2VtZW50KS5cbiAqIDYuIEFmdGVyIGNyZWF0aW5nIGEgbmV3IHZlcnNpb24sIHVwZGF0ZSBHVUFSRFJBSUxfVkVSU0lPTiBlbnYgdmFyIGluIGFnZW50Y29yZS5qc29uXG4gKiAgICBhbmQgcmVkZXBsb3kgdGhlIGFnZW50LlxuICovXG5leHBvcnQgY2xhc3MgR3VhcmRyYWlsU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgZ3VhcmRyYWlsSWQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGd1YXJkcmFpbFZlcnNpb246IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGd1YXJkcmFpbEFybjogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IGd1YXJkcmFpbCA9IG5ldyBiZWRyb2NrLkNmbkd1YXJkcmFpbCh0aGlzLCBcIlBhcnR5U3VwcGx5R3VhcmRyYWlsXCIsIHtcbiAgICAgIG5hbWU6IFwiUGFydHlTdXBwbHlHdWFyZHJhaWxcIixcbiAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICBcIkNvbnRlbnQgZmlsdGVyaW5nIGZvciBwYXJ0eSBzdXBwbHkgY2hhdCBhZ2VudCAtIGFsbG93cyByZWxpZ2lvdXMgb2NjYXNpb25zXCIsXG4gICAgICBibG9ja2VkSW5wdXRNZXNzYWdpbmc6XG4gICAgICAgIFwiSSdtIHNvcnJ5LCBJIGNhbid0IGhlbHAgd2l0aCB0aGF0IHJlcXVlc3QuIExldCBtZSBrbm93IGlmIHlvdSBoYXZlIHF1ZXN0aW9ucyBhYm91dCBwYXJ0eSBzdXBwbGllcyFcIixcbiAgICAgIGJsb2NrZWRPdXRwdXRzTWVzc2FnaW5nOlxuICAgICAgICBcIkknbSBzb3JyeSwgSSBjYW4ndCBwcm92aWRlIHRoYXQgaW5mb3JtYXRpb24uIElzIHRoZXJlIGFueXRoaW5nIGVsc2UgYWJvdXQgcGFydHkgc3VwcGxpZXMgSSBjYW4gaGVscCB3aXRoP1wiLFxuXG4gICAgICAvLyBDb250ZW50IGZpbHRlcnMgLSB1c2UgTE9XIHNlbnNpdGl2aXR5IHRvIGF2b2lkIGJsb2NraW5nIGxlZ2l0aW1hdGUgcGFydHkgc3VwcGx5IHF1ZXJpZXNcbiAgICAgIC8vIFBhcnR5IHN1cHBsaWVzIGluY2x1ZGUgdGhlbWVzIGxpa2UgSGFsbG93ZWVuICh2aW9sZW5jZSBpbWFnZXJ5KSwgd2VkZGluZ3MgKHJvbWFuY2UpLCBldGMuXG4gICAgICBjb250ZW50UG9saWN5Q29uZmlnOiB7XG4gICAgICAgIGZpbHRlcnNDb25maWc6IFtcbiAgICAgICAgICB7IHR5cGU6IFwiSEFURVwiLCBpbnB1dFN0cmVuZ3RoOiBcIkhJR0hcIiwgb3V0cHV0U3RyZW5ndGg6IFwiSElHSFwiIH0sXG4gICAgICAgICAgeyB0eXBlOiBcIklOU1VMVFNcIiwgaW5wdXRTdHJlbmd0aDogXCJMT1dcIiwgb3V0cHV0U3RyZW5ndGg6IFwiTE9XXCIgfSxcbiAgICAgICAgICB7IHR5cGU6IFwiU0VYVUFMXCIsIGlucHV0U3RyZW5ndGg6IFwiTUVESVVNXCIsIG91dHB1dFN0cmVuZ3RoOiBcIk1FRElVTVwiIH0sXG4gICAgICAgICAgeyB0eXBlOiBcIlZJT0xFTkNFXCIsIGlucHV0U3RyZW5ndGg6IFwiTE9XXCIsIG91dHB1dFN0cmVuZ3RoOiBcIkxPV1wiIH0sXG4gICAgICAgICAgeyB0eXBlOiBcIk1JU0NPTkRVQ1RcIiwgaW5wdXRTdHJlbmd0aDogXCJMT1dcIiwgb3V0cHV0U3RyZW5ndGg6IFwiTE9XXCIgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG5cbiAgICAgIC8vIERlbmllZCB0b3BpY3MgLSBrZWVwIGFnZW50IGZvY3VzZWQgb24gcGFydHkgc3VwcGxpZXNcbiAgICAgIC8vIE5vdGU6IFJlbGlnaW91cyB0b3BpY3MgYXJlIE5PVCBkZW5pZWQgc2luY2UgcHJvZHVjdHMgaW5jbHVkZSByZWxpZ2lvdXMgb2NjYXNpb25zXG4gICAgICB0b3BpY1BvbGljeUNvbmZpZzoge1xuICAgICAgICB0b3BpY3NDb25maWc6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBuYW1lOiBcIkNvbXBldGl0b3JzXCIsXG4gICAgICAgICAgICBkZWZpbml0aW9uOlxuICAgICAgICAgICAgICBcIk1lbnRpb25zIG9mIGNvbXBldGl0b3IgbmFtZXM6IFBhcnR5IENpdHksIEFtYXpvbiwgV2FsbWFydCwgVGFyZ2V0LCBPcmllbnRhbCBUcmFkaW5nLCBvciBwcmljZSBjb21wYXJpc29ucyB3aXRoIG90aGVyIHN0b3Jlc1wiLFxuICAgICAgICAgICAgdHlwZTogXCJERU5ZXCIsXG4gICAgICAgICAgICBleGFtcGxlczogW1xuICAgICAgICAgICAgICBcIldoYXQgYWJvdXQgUGFydHkgQ2l0eT9cIixcbiAgICAgICAgICAgICAgXCJJcyBBbWF6b24gY2hlYXBlcj9cIixcbiAgICAgICAgICAgICAgXCJCdXkgZnJvbSBPcmllbnRhbCBUcmFkaW5nXCIsXG4gICAgICAgICAgICAgIFwiQ29tcGFyZSB0byBXYWxtYXJ0XCIsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgbmFtZTogXCJQb2xpdGljc1wiLFxuICAgICAgICAgICAgZGVmaW5pdGlvbjpcbiAgICAgICAgICAgICAgXCJQb2xpdGljYWwgZGlzY3Vzc2lvbnMsIGNhbmRpZGF0ZXMsIGVsZWN0aW9ucywgcG9saXRpY2FsIHBhcnRpZXMsIG9yIHBvbGl0aWNhbGx5IGRpdmlzaXZlIHRvcGljc1wiLFxuICAgICAgICAgICAgdHlwZTogXCJERU5ZXCIsXG4gICAgICAgICAgICBleGFtcGxlczogW1xuICAgICAgICAgICAgICBcIldoYXQgZG8geW91IHRoaW5rIGFib3V0IHRoZSBlbGVjdGlvbj9cIixcbiAgICAgICAgICAgICAgXCJXaGljaCBwb2xpdGljYWwgcGFydHkgaXMgYmV0dGVyP1wiLFxuICAgICAgICAgICAgICBcIlNob3VsZCBJIHZvdGUgZm9yIGNhbmRpZGF0ZSBYP1wiLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIG5hbWU6IFwiTWVkaWNhbEFkdmljZVwiLFxuICAgICAgICAgICAgZGVmaW5pdGlvbjpcbiAgICAgICAgICAgICAgXCJNZWRpY2FsIGFkdmljZSwgaGVhbHRoIGRpYWdub3Nlcywgb3IgdHJlYXRtZW50IHJlY29tbWVuZGF0aW9uc1wiLFxuICAgICAgICAgICAgdHlwZTogXCJERU5ZXCIsXG4gICAgICAgICAgICBleGFtcGxlczogW1xuICAgICAgICAgICAgICBcIklzIHRoaXMgYmFsbG9vbiBsYXRleCBzYWZlIGZvciBteSBhbGxlcmd5P1wiLFxuICAgICAgICAgICAgICBcIkNhbiBlYXRpbmcgY2FrZSBkZWNvcmF0aW9ucyBtYWtlIHlvdSBzaWNrP1wiLFxuICAgICAgICAgICAgICBcIldoYXQgbWVkaWNpbmUgc2hvdWxkIEkgdGFrZT9cIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBuYW1lOiBcIkxlZ2FsQWR2aWNlXCIsXG4gICAgICAgICAgICBkZWZpbml0aW9uOlxuICAgICAgICAgICAgICBcIkxlZ2FsIGFkdmljZSwgY29udHJhY3QgaW50ZXJwcmV0YXRpb24sIG9yIGxpYWJpbGl0eSBndWlkYW5jZVwiLFxuICAgICAgICAgICAgdHlwZTogXCJERU5ZXCIsXG4gICAgICAgICAgICBleGFtcGxlczogW1xuICAgICAgICAgICAgICBcIkNhbiBJIHN1ZSBpZiBzb21lb25lIGNob2tlcyBvbiBjb25mZXR0aT9cIixcbiAgICAgICAgICAgICAgXCJJcyBpdCBsZWdhbCB0byB1c2UgZmlyZXdvcmtzIGF0IG15IHBhcnR5P1wiLFxuICAgICAgICAgICAgICBcIldoYXQgYXJlIG15IHJpZ2h0cyBpZiB0aGUgb3JkZXIgaXMgbGF0ZT9cIixcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG5cbiAgICAgIC8vIFNlbnNpdGl2ZSBpbmZvcm1hdGlvbiBmaWx0ZXJzIC0gcHJvdGVjdCBQSUlcbiAgICAgIHNlbnNpdGl2ZUluZm9ybWF0aW9uUG9saWN5Q29uZmlnOiB7XG4gICAgICAgIHBpaUVudGl0aWVzQ29uZmlnOiBbXG4gICAgICAgICAgeyB0eXBlOiBcIkNSRURJVF9ERUJJVF9DQVJEX05VTUJFUlwiLCBhY3Rpb246IFwiQkxPQ0tcIiB9LFxuICAgICAgICAgIHsgdHlwZTogXCJDUkVESVRfREVCSVRfQ0FSRF9DVlZcIiwgYWN0aW9uOiBcIkJMT0NLXCIgfSxcbiAgICAgICAgICB7IHR5cGU6IFwiQ1JFRElUX0RFQklUX0NBUkRfRVhQSVJZXCIsIGFjdGlvbjogXCJCTE9DS1wiIH0sXG4gICAgICAgICAgeyB0eXBlOiBcIlVTX1NPQ0lBTF9TRUNVUklUWV9OVU1CRVJcIiwgYWN0aW9uOiBcIkJMT0NLXCIgfSxcbiAgICAgICAgICB7IHR5cGU6IFwiVVNfQkFOS19BQ0NPVU5UX05VTUJFUlwiLCBhY3Rpb246IFwiQkxPQ0tcIiB9LFxuICAgICAgICAgIHsgdHlwZTogXCJVU19CQU5LX1JPVVRJTkdfTlVNQkVSXCIsIGFjdGlvbjogXCJCTE9DS1wiIH0sXG4gICAgICAgICAgeyB0eXBlOiBcIkVNQUlMXCIsIGFjdGlvbjogXCJBTk9OWU1JWkVcIiB9LFxuICAgICAgICAgIHsgdHlwZTogXCJQSE9ORVwiLCBhY3Rpb246IFwiQU5PTllNSVpFXCIgfSxcbiAgICAgICAgICB7IHR5cGU6IFwiTkFNRVwiLCBhY3Rpb246IFwiQU5PTllNSVpFXCIgfSxcbiAgICAgICAgICB7IHR5cGU6IFwiQUREUkVTU1wiLCBhY3Rpb246IFwiQU5PTllNSVpFXCIgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgZ3VhcmRyYWlsIHZlcnNpb24gZm9yIHByb2R1Y3Rpb24gdXNlXG4gICAgLy8gRGVzY3JpcHRpb24gY2hhbmdlIGZvcmNlcyBhIG5ldyB2ZXJzaW9uIG9uIGVhY2ggZGVwbG95bWVudFxuICAgIGNvbnN0IGd1YXJkcmFpbFZlcnNpb24gPSBuZXcgYmVkcm9jay5DZm5HdWFyZHJhaWxWZXJzaW9uKFxuICAgICAgdGhpcyxcbiAgICAgIFwiUGFydHlTdXBwbHlHdWFyZHJhaWxWZXJzaW9uXCIsXG4gICAgICB7XG4gICAgICAgIGd1YXJkcmFpbElkZW50aWZpZXI6IGd1YXJkcmFpbC5hdHRyR3VhcmRyYWlsSWQsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcInYzIC0gRml4ZWQgQ29tcGV0aXRvcnMgdG9waWMgZmFsc2UgcG9zaXRpdmVzXCIsXG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIFN0b3JlIGZvciByZWZlcmVuY2VcbiAgICB0aGlzLmd1YXJkcmFpbElkID0gZ3VhcmRyYWlsLmF0dHJHdWFyZHJhaWxJZDtcbiAgICB0aGlzLmd1YXJkcmFpbFZlcnNpb24gPSBndWFyZHJhaWxWZXJzaW9uLmF0dHJWZXJzaW9uO1xuICAgIHRoaXMuZ3VhcmRyYWlsQXJuID0gZ3VhcmRyYWlsLmF0dHJHdWFyZHJhaWxBcm47XG5cbiAgICAvLyBPdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJHdWFyZHJhaWxJZFwiLCB7XG4gICAgICBkZXNjcmlwdGlvbjogXCJCZWRyb2NrIEd1YXJkcmFpbCBJRFwiLFxuICAgICAgdmFsdWU6IGd1YXJkcmFpbC5hdHRyR3VhcmRyYWlsSWQsXG4gICAgICBleHBvcnROYW1lOiBcIlBhcnR5U3VwcGx5LUd1YXJkcmFpbElkXCIsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIkd1YXJkcmFpbFZlcnNpb25cIiwge1xuICAgICAgZGVzY3JpcHRpb246IFwiQmVkcm9jayBHdWFyZHJhaWwgVmVyc2lvblwiLFxuICAgICAgdmFsdWU6IGd1YXJkcmFpbFZlcnNpb24uYXR0clZlcnNpb24sXG4gICAgICBleHBvcnROYW1lOiBcIlBhcnR5U3VwcGx5LUd1YXJkcmFpbFZlcnNpb25cIixcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiR3VhcmRyYWlsQXJuXCIsIHtcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkJlZHJvY2sgR3VhcmRyYWlsIEFSTlwiLFxuICAgICAgdmFsdWU6IGd1YXJkcmFpbC5hdHRyR3VhcmRyYWlsQXJuLFxuICAgICAgZXhwb3J0TmFtZTogXCJQYXJ0eVN1cHBseS1HdWFyZHJhaWxBcm5cIixcbiAgICB9KTtcbiAgfVxufVxuIl19