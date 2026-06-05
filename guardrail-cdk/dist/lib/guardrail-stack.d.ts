import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
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
export declare class GuardrailStack extends cdk.Stack {
    readonly guardrailId: string;
    readonly guardrailVersion: string;
    readonly guardrailArn: string;
    constructor(scope: Construct, id: string, props?: cdk.StackProps);
}
