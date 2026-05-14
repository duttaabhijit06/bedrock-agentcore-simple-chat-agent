/**
 * AgentCore Memory Integration
 *
 * Provides long-term memory for the Party Supply agent using AgentCore Memory.
 * Stores conversation events and retrieves relevant memories for context.
 *
 * Strategies configured:
 *   - SEMANTIC: Extracts factual information from conversations
 *   - SUMMARIZATION: Creates session summaries
 *   - USER_PREFERENCE: Learns customer preferences (themes, budgets, etc.)
 */

import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
  ListEventsCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const REGION = process.env.AWS_REGION || "us-west-2";
const MEMORY_NAME = process.env.MEMORY_NAME || "PartySupplyMemory";

const client = new BedrockAgentCoreClient({ region: REGION });

/**
 * Store a conversation event in short-term memory.
 * This triggers long-term memory extraction via configured strategies.
 */
export async function storeConversationEvent(
  sessionId: string,
  actorId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  try {
    await client.send(
      new CreateEventCommand({
        memoryId: MEMORY_NAME,
        actorId,
        sessionId,
        eventTimestamp: new Date(),
        payload: [
          {
            conversational: {
              content: { text: content },
              role: role === "user" ? "USER" : "ASSISTANT",
            },
          },
        ],
      })
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn("Failed to store memory event:", msg);
  }
}

/**
 * Retrieve relevant long-term memories for a given query.
 * Searches across all strategy namespaces (facts, preferences, summaries).
 */
export async function retrieveMemories(
  actorId: string,
  query: string,
  maxResults: number = 5
): Promise<string[]> {
  try {
    const response = await client.send(
      new RetrieveMemoryRecordsCommand({
        memoryId: MEMORY_NAME,
        namespace: `/preferences/${actorId}/`,
        searchCriteria: {
          searchQuery: query,
          topK: maxResults,
        },
      })
    );

    return (
      response.memoryRecordSummaries?.map((record) => {
        const content =
          record.content && "text" in record.content
            ? record.content.text
            : "";
        return content;
      }).filter((s): s is string => Boolean(s)) || []
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn("Failed to retrieve memories:", msg);
    return [];
  }
}

/**
 * Get recent conversation history from short-term memory.
 */
export async function getRecentEvents(
  sessionId: string,
  actorId: string,
  maxEvents: number = 10
): Promise<string[]> {
  try {
    const response = await client.send(
      new ListEventsCommand({
        memoryId: MEMORY_NAME,
        sessionId,
        actorId,
        maxResults: maxEvents,
      })
    );

    return (
      response.events?.map((event) => {
        const payload = event.payload;
        if (!payload || payload.length === 0) return "";
        const first = payload[0];
        if ("conversational" in first && first.conversational?.content) {
          const content = first.conversational.content;
          if ("text" in content) return content.text;
        }
        return "";
      }).filter((s): s is string => Boolean(s)) || []
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn("Failed to get recent events:", msg);
    return [];
  }
}
