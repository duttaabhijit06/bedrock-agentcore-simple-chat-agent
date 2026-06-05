import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
/**
 * Batch Processing Stack with Step Functions Orchestration
 *
 * Flow (all orchestrated by Step Functions):
 * 1. Glue ETL (dedup CSV → JSONL chunks)
 * 2. Lambda (submit Bedrock Batch jobs)
 * 3. Poll loop (check batch job status every 60s)
 * 4. Lambda (flush index for replace mode)
 * 5. Glue Python Shell (upload to S3 Vectors)
 */
export declare class BatchProcessingStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps);
}
