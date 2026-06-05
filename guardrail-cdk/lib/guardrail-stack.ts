import * as cdk from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
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
export class GuardrailStack extends cdk.Stack {
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;
  public readonly guardrailArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const guardrail = new bedrock.CfnGuardrail(this, "PartySupplyGuardrail", {
      name: "PartySupplyGuardrail",
      description:
        "Content filtering for party supply chat agent - allows religious occasions",
      blockedInputMessaging:
        "I'm sorry, I can't help with that request. Let me know if you have questions about party supplies!",
      blockedOutputsMessaging:
        "I'm sorry, I can't provide that information. Is there anything else about party supplies I can help with?",

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
            definition:
              "Mentions of competitor names: Party City, Amazon, Walmart, Target, Oriental Trading, or price comparisons with other stores",
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
            definition:
              "Political discussions, candidates, elections, political parties, or politically divisive topics",
            type: "DENY",
            examples: [
              "What do you think about the election?",
              "Which political party is better?",
              "Should I vote for candidate X?",
            ],
          },
          {
            name: "MedicalAdvice",
            definition:
              "Medical advice, health diagnoses, or treatment recommendations",
            type: "DENY",
            examples: [
              "Is this balloon latex safe for my allergy?",
              "Can eating cake decorations make you sick?",
              "What medicine should I take?",
            ],
          },
          {
            name: "LegalAdvice",
            definition:
              "Legal advice, contract interpretation, or liability guidance",
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
    const guardrailVersion = new bedrock.CfnGuardrailVersion(
      this,
      "PartySupplyGuardrailVersion",
      {
        guardrailIdentifier: guardrail.attrGuardrailId,
        description: "v3 - Fixed Competitors topic false positives",
      }
    );

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
