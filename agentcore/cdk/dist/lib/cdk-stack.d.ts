import { AgentCoreApplication, type AgentCoreProjectSpec, type AgentCoreMcpSpec } from '@aws/agentcore-cdk';
import { Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
export interface AgentCoreStackProps extends StackProps {
    /**
     * The AgentCore project specification containing agents, memories, and credentials.
     */
    spec: AgentCoreProjectSpec;
    /**
     * The MCP specification containing gateways and servers.
     */
    mcpSpec?: AgentCoreMcpSpec;
    /**
     * Credential provider ARNs from deployed state, keyed by credential name.
     */
    credentials?: Record<string, {
        credentialProviderArn: string;
        clientSecretArn?: string;
    }>;
}
/**
 * CDK Stack that deploys AgentCore infrastructure.
 *
 * This is a thin wrapper that instantiates L3 constructs.
 * All resource logic and outputs are contained within the L3 constructs.
 */
export declare class AgentCoreStack extends Stack {
    /** The AgentCore application containing all agent environments */
    readonly application: AgentCoreApplication;
    constructor(scope: Construct, id: string, props: AgentCoreStackProps);
}
