"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchProcessingStack = void 0;
const cdk = require("aws-cdk-lib");
const s3 = require("aws-cdk-lib/aws-s3");
const iam = require("aws-cdk-lib/aws-iam");
const lambda = require("aws-cdk-lib/aws-lambda");
const glue = require("aws-cdk-lib/aws-glue");
const sfn = require("aws-cdk-lib/aws-stepfunctions");
const tasks = require("aws-cdk-lib/aws-stepfunctions-tasks");
const path = require("path");
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
class BatchProcessingStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const region = cdk.Stack.of(this).region;
        const account = cdk.Stack.of(this).account;
        const vectorBucketName = "party-supply-vectors";
        // ─── S3 Bucket for Batch Jobs ───────────────────────────────────────────
        // Import existing bucket (created by deploy.sh before CDK runs)
        const bucketName = `party-supply-batch-${account}-${region}`;
        const batchBucket = s3.Bucket.fromBucketName(this, "BatchBucket", bucketName);
        // ─── IAM Role for Glue Jobs ─────────────────────────────────────────────
        const glueRole = new iam.Role(this, "GlueRole", {
            roleName: "PartySupplyGlueRole",
            assumedBy: new iam.ServicePrincipal("glue.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole"),
            ],
        });
        glueRole.addToPolicy(new iam.PolicyStatement({
            actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
            resources: [batchBucket.bucketArn, `${batchBucket.bucketArn}/*`],
        }));
        glueRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "s3vectors:PutVectors",
                "s3vectors:GetVectors",
                "s3vectors:DeleteVectors",
                "s3vectors:ListVectors",
                "s3vectors:QueryVectors",
                "s3vectors:GetIndex",
                "s3vectors:ListIndexes",
                "s3vectors:CreateIndex",
                "s3vectors:DeleteIndex",
            ],
            resources: [
                `arn:aws:s3vectors:${region}:${account}:bucket/${vectorBucketName}`,
                `arn:aws:s3vectors:${region}:${account}:bucket/${vectorBucketName}/index/*`,
            ],
        }));
        // ─── Glue Job: Dedup & Prepare JSONL ────────────────────────────────────
        const dedupJob = new glue.CfnJob(this, "DedupPrepareJob", {
            name: "PartySupplyDedupPrepare",
            role: glueRole.roleArn,
            command: {
                name: "glueetl",
                scriptLocation: `s3://${batchBucket.bucketName}/glue-scripts/dedup-prepare.py`,
                pythonVersion: "3",
            },
            defaultArguments: {
                "--job-language": "python",
                "--enable-metrics": "true",
                "--TempDir": `s3://${batchBucket.bucketName}/glue-temp/`,
            },
            executionProperty: {
                maxConcurrentRuns: 10,
            },
            glueVersion: "4.0",
            numberOfWorkers: 2,
            workerType: "G.1X",
        });
        // ─── Glue Job: Upload Vectors ───────────────────────────────────────────
        const uploadVectorsJob = new glue.CfnJob(this, "UploadVectorsJob", {
            name: "PartySupplyUploadVectors",
            role: glueRole.roleArn,
            command: {
                name: "pythonshell",
                scriptLocation: `s3://${batchBucket.bucketName}/glue-scripts/upload-vectors.py`,
                pythonVersion: "3.9",
            },
            defaultArguments: {
                "--job-language": "python",
                "--additional-python-modules": "boto3>=1.28.0",
            },
            executionProperty: {
                maxConcurrentRuns: 10,
            },
            maxCapacity: 1.0,
            timeout: 120,
        });
        // ─── IAM Role for Lambda Functions ──────────────────────────────────────
        const lambdaRole = new iam.Role(this, "LambdaRole", {
            roleName: "PartySupplyBatchLambdaRole",
            assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
            ],
        });
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:CopyObject"],
            resources: [`arn:aws:s3:::party-supply-batch-*`, `arn:aws:s3:::party-supply-batch-*/*`],
        }));
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "bedrock:CreateModelInvocationJob",
                "bedrock:GetModelInvocationJob",
                "bedrock:ListModelInvocationJobs",
            ],
            resources: ["*"],
        }));
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ["iam:PassRole"],
            resources: [`arn:aws:iam::${account}:role/PartySupplyBatchInferenceRole`],
        }));
        // S3 Vectors permissions for flush (replace mode)
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "s3vectors:DeleteIndex",
                "s3vectors:CreateIndex",
                "s3vectors:GetIndex",
            ],
            resources: [
                `arn:aws:s3vectors:${region}:${account}:bucket/${vectorBucketName}`,
                `arn:aws:s3vectors:${region}:${account}:bucket/${vectorBucketName}/index/*`,
            ],
        }));
        // ─── IAM Role for Bedrock Batch Inference ───────────────────────────────
        const batchInferenceRole = new iam.Role(this, "BatchInferenceRole", {
            roleName: "PartySupplyBatchInferenceRole",
            assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
        });
        batchInferenceRole.addToPolicy(new iam.PolicyStatement({
            actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
            resources: [batchBucket.bucketArn, `${batchBucket.bucketArn}/*`],
        }));
        batchInferenceRole.addToPolicy(new iam.PolicyStatement({
            actions: ["bedrock:InvokeModel"],
            resources: [`arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`],
        }));
        // ─── Lambda: Submit Batch Jobs ──────────────────────────────────────────
        const lambdaCodePath = path.join(__dirname, "../../scripts/batch-result-lambda");
        const submitBatchLambda = new lambda.Function(this, "SubmitBatchLambda", {
            functionName: "PartySupplyBatchSubmit",
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: "submit-batch.handler",
            code: lambda.Code.fromAsset(lambdaCodePath),
            role: lambdaRole,
            timeout: cdk.Duration.seconds(120),
            memorySize: 256,
            environment: {
                BATCH_BUCKET: batchBucket.bucketName,
                BATCH_ROLE_ARN: batchInferenceRole.roleArn,
                MODEL_ID: "amazon.titan-embed-text-v2:0",
            },
        });
        // ─── Lambda: Check Batch Job Status ─────────────────────────────────────
        const checkJobsLambda = new lambda.Function(this, "CheckJobsLambda", {
            functionName: "PartySupplyBatchCheckJobs",
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: "check-jobs.handler",
            code: lambda.Code.fromAsset(lambdaCodePath),
            role: lambdaRole,
            timeout: cdk.Duration.seconds(60),
            memorySize: 256,
            environment: {
                BATCH_BUCKET: batchBucket.bucketName,
            },
        });
        // ─── Lambda: Flush Index (for replace mode) ─────────────────────────────
        const flushIndexLambda = new lambda.Function(this, "FlushIndexLambda", {
            functionName: "PartySupplyBatchFlushIndex",
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: "flush-index.handler",
            code: lambda.Code.fromAsset(lambdaCodePath),
            role: lambdaRole,
            timeout: cdk.Duration.seconds(60),
            memorySize: 256,
            environment: {
                VECTOR_BUCKET: vectorBucketName,
            },
        });
        // ─── Step Functions State Machine ───────────────────────────────────────
        // Step 1: Run Glue ETL job for deduplication
        const runGlueDedup = new tasks.GlueStartJobRun(this, "RunGlueDedup", {
            glueJobName: "PartySupplyDedupPrepare",
            integrationPattern: sfn.IntegrationPattern.RUN_JOB,
            arguments: sfn.TaskInput.fromObject({
                "--data_type": sfn.JsonPath.stringAt("$.dataType"),
                "--input_path": sfn.JsonPath.stringAt("$.inputPath"),
                "--output_path": sfn.JsonPath.stringAt("$.outputPath"),
                "--chunk_size": "50000",
            }),
            resultPath: "$.glueResult",
        });
        // Step 2: Submit Bedrock Batch jobs
        const submitBatchJobs = new tasks.LambdaInvoke(this, "SubmitBatchJobs", {
            lambdaFunction: submitBatchLambda,
            payload: sfn.TaskInput.fromObject({
                dataType: sfn.JsonPath.stringAt("$.dataType"),
                preparedPath: sfn.JsonPath.stringAt("$.outputPath"),
                uploadMode: sfn.JsonPath.stringAt("$.uploadMode"),
            }),
            resultSelector: {
                "jobCount.$": "$.Payload.jobCount",
                "manifestName.$": "$.Payload.manifestName",
                "jobs.$": "$.Payload.jobs",
            },
            resultPath: "$.batchResult",
        });
        // Step 3: Check batch job status
        const checkBatchStatus = new tasks.LambdaInvoke(this, "CheckBatchStatus", {
            lambdaFunction: checkJobsLambda,
            payload: sfn.TaskInput.fromObject({
                jobs: sfn.JsonPath.stringAt("$.batchResult.jobs"),
            }),
            resultSelector: {
                "allComplete.$": "$.Payload.allComplete",
                "anyFailed.$": "$.Payload.anyFailed",
                "status.$": "$.Payload.status",
            },
            resultPath: "$.checkResult",
        });
        // Wait state for polling
        const waitForBatch = new sfn.Wait(this, "WaitForBatch", {
            time: sfn.WaitTime.duration(cdk.Duration.seconds(60)),
        });
        // Step 4: Flush index (for replace mode)
        const flushIndex = new tasks.LambdaInvoke(this, "FlushIndex", {
            lambdaFunction: flushIndexLambda,
            payload: sfn.TaskInput.fromObject({
                dataType: sfn.JsonPath.stringAt("$.dataType"),
            }),
            resultPath: "$.flushResult",
        });
        // Step 5: Run Glue upload jobs (one per chunk)
        // Paths are constructed using States.Format intrinsic function
        const runGlueUpload = new tasks.GlueStartJobRun(this, "RunGlueUpload", {
            glueJobName: "PartySupplyUploadVectors",
            integrationPattern: sfn.IntegrationPattern.RUN_JOB,
            arguments: sfn.TaskInput.fromObject({
                "--data_type": sfn.JsonPath.stringAt("$.dataType"),
                "--batch_output_path": sfn.JsonPath.format("s3://{}/{}/", sfn.JsonPath.stringAt("$.bucketName"), sfn.JsonPath.stringAt("$.outputPrefix")),
                "--raw_data_path": sfn.JsonPath.format("{}raw/", sfn.JsonPath.stringAt("$.outputPath")),
                "--vector_bucket": vectorBucketName,
                "--region": region,
                "--upload_mode": "upsert",
            }),
            resultPath: "$.uploadResult",
        });
        // Map state to process each batch job output
        const processChunks = new sfn.Map(this, "ProcessChunks", {
            itemsPath: "$.batchResult.jobs",
            itemSelector: {
                "dataType.$": "$.dataType",
                "outputPath.$": "$.outputPath",
                "uploadMode.$": "$.uploadMode",
                "bucketName": bucketName,
                "outputPrefix.$": "$$.Map.Item.Value.outputPrefix",
            },
            maxConcurrency: 3,
            resultPath: "$.uploadResults",
        });
        processChunks.itemProcessor(runGlueUpload);
        // Success state
        const successState = new sfn.Succeed(this, "ImportComplete", {
            comment: "Batch import completed successfully",
        });
        // Failure state
        const failureState = new sfn.Fail(this, "ImportFailed", {
            cause: "One or more batch jobs failed",
            error: "BatchJobFailed",
        });
        // Skip flush for non-replace mode
        const skipFlush = new sfn.Pass(this, "SkipFlush", {
            resultPath: "$.flushResult",
        });
        // Choice: check if replace mode
        const checkReplaceMode = new sfn.Choice(this, "CheckReplaceMode")
            .when(sfn.Condition.stringEquals("$.uploadMode", "replace"), flushIndex.next(processChunks))
            .otherwise(skipFlush.next(processChunks));
        // Choice: check if all jobs complete
        const checkComplete = new sfn.Choice(this, "CheckComplete")
            .when(sfn.Condition.booleanEquals("$.checkResult.anyFailed", true), failureState)
            .when(sfn.Condition.booleanEquals("$.checkResult.allComplete", true), checkReplaceMode)
            .otherwise(waitForBatch.next(checkBatchStatus));
        // Build the state machine
        const definition = runGlueDedup
            .next(submitBatchJobs)
            .next(checkBatchStatus)
            .next(checkComplete);
        processChunks.next(successState);
        const stateMachine = new sfn.StateMachine(this, "BatchImportStateMachine", {
            stateMachineName: "PartySupplyBatchImport",
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            timeout: cdk.Duration.hours(4),
        });
        // Grant Step Functions permission to invoke Glue
        stateMachine.addToRolePolicy(new iam.PolicyStatement({
            actions: ["glue:StartJobRun", "glue:GetJobRun", "glue:GetJobRuns", "glue:BatchStopJobRun"],
            resources: [
                `arn:aws:glue:${region}:${account}:job/PartySupplyDedupPrepare`,
                `arn:aws:glue:${region}:${account}:job/PartySupplyUploadVectors`,
            ],
        }));
        // ─── Outputs ────────────────────────────────────────────────────────────
        new cdk.CfnOutput(this, "BatchBucketName", {
            value: batchBucket.bucketName,
            description: "S3 bucket for batch job I/O",
        });
        new cdk.CfnOutput(this, "StateMachineArn", {
            value: stateMachine.stateMachineArn,
            description: "Step Functions state machine ARN",
        });
        new cdk.CfnOutput(this, "GlueDedupJobName", {
            value: dedupJob.name,
            description: "Glue ETL job for deduplication",
        });
        new cdk.CfnOutput(this, "GlueUploadJobName", {
            value: uploadVectorsJob.name,
            description: "Glue Python Shell job for vector upload",
        });
        new cdk.CfnOutput(this, "SubmitBatchLambdaArn", {
            value: submitBatchLambda.functionArn,
            description: "Lambda to submit Bedrock Batch jobs",
        });
        new cdk.CfnOutput(this, "BatchInferenceRoleArn", {
            value: batchInferenceRole.roleArn,
            description: "IAM role for Bedrock Batch Inference",
        });
    }
}
exports.BatchProcessingStack = BatchProcessingStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmF0Y2gtcHJvY2Vzc2luZy1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9iYXRjaC1wcm9jZXNzaW5nLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUNuQyx5Q0FBeUM7QUFDekMsMkNBQTJDO0FBQzNDLGlEQUFpRDtBQUNqRCw2Q0FBNkM7QUFDN0MscURBQXFEO0FBQ3JELDZEQUE2RDtBQUU3RCw2QkFBNkI7QUFFN0I7Ozs7Ozs7OztHQVNHO0FBQ0gsTUFBYSxvQkFBcUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUNqRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sQ0FBQztRQUN6QyxNQUFNLE9BQU8sR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxPQUFPLENBQUM7UUFDM0MsTUFBTSxnQkFBZ0IsR0FBRyxzQkFBc0IsQ0FBQztRQUVoRCwyRUFBMkU7UUFDM0UsZ0VBQWdFO1FBRWhFLE1BQU0sVUFBVSxHQUFHLHNCQUFzQixPQUFPLElBQUksTUFBTSxFQUFFLENBQUM7UUFDN0QsTUFBTSxXQUFXLEdBQUcsRUFBRSxDQUFDLE1BQU0sQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRSxVQUFVLENBQUMsQ0FBQztRQUU5RSwyRUFBMkU7UUFFM0UsTUFBTSxRQUFRLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDOUMsUUFBUSxFQUFFLHFCQUFxQjtZQUMvQixTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsb0JBQW9CLENBQUM7WUFD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QWdCLENBQUMsSUFBSztZQUM3QixXQUFXLEVBQUUseUNBQXlDO1NBQ3ZELENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLEVBQUU7WUFDOUMsS0FBSyxFQUFFLGlCQUFpQixDQUFDLFdBQVc7WUFDcEMsV0FBVyxFQUFFLHFDQUFxQztTQUNuRCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHVCQUF1QixFQUFFO1lBQy9DLEtBQUssRUFBRSxrQkFBa0IsQ0FBQyxPQUFPO1lBQ2pDLFdBQVcsRUFBRSxzQ0FBc0M7U0FDcEQsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBcllELG9EQXFZQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBnbHVlIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZ2x1ZVwiO1xuaW1wb3J0ICogYXMgc2ZuIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc3RlcGZ1bmN0aW9uc1wiO1xuaW1wb3J0ICogYXMgdGFza3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zdGVwZnVuY3Rpb25zLXRhc2tzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwicGF0aFwiO1xuXG4vKipcbiAqIEJhdGNoIFByb2Nlc3NpbmcgU3RhY2sgd2l0aCBTdGVwIEZ1bmN0aW9ucyBPcmNoZXN0cmF0aW9uXG4gKlxuICogRmxvdyAoYWxsIG9yY2hlc3RyYXRlZCBieSBTdGVwIEZ1bmN0aW9ucyk6XG4gKiAxLiBHbHVlIEVUTCAoZGVkdXAgQ1NWIOKGkiBKU09OTCBjaHVua3MpXG4gKiAyLiBMYW1iZGEgKHN1Ym1pdCBCZWRyb2NrIEJhdGNoIGpvYnMpXG4gKiAzLiBQb2xsIGxvb3AgKGNoZWNrIGJhdGNoIGpvYiBzdGF0dXMgZXZlcnkgNjBzKVxuICogNC4gTGFtYmRhIChmbHVzaCBpbmRleCBmb3IgcmVwbGFjZSBtb2RlKVxuICogNS4gR2x1ZSBQeXRob24gU2hlbGwgKHVwbG9hZCB0byBTMyBWZWN0b3JzKVxuICovXG5leHBvcnQgY2xhc3MgQmF0Y2hQcm9jZXNzaW5nU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCByZWdpb24gPSBjZGsuU3RhY2sub2YodGhpcykucmVnaW9uO1xuICAgIGNvbnN0IGFjY291bnQgPSBjZGsuU3RhY2sub2YodGhpcykuYWNjb3VudDtcbiAgICBjb25zdCB2ZWN0b3JCdWNrZXROYW1lID0gXCJwYXJ0eS1zdXBwbHktdmVjdG9yc1wiO1xuXG4gICAgLy8g4pSA4pSA4pSAIFMzIEJ1Y2tldCBmb3IgQmF0Y2ggSm9icyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICAvLyBJbXBvcnQgZXhpc3RpbmcgYnVja2V0IChjcmVhdGVkIGJ5IGRlcGxveS5zaCBiZWZvcmUgQ0RLIHJ1bnMpXG5cbiAgICBjb25zdCBidWNrZXROYW1lID0gYHBhcnR5LXN1cHBseS1iYXRjaC0ke2FjY291bnR9LSR7cmVnaW9ufWA7XG4gICAgY29uc3QgYmF0Y2hCdWNrZXQgPSBzMy5CdWNrZXQuZnJvbUJ1Y2tldE5hbWUodGhpcywgXCJCYXRjaEJ1Y2tldFwiLCBidWNrZXROYW1lKTtcblxuICAgIC8vIOKUgOKUgOKUgCBJQU0gUm9sZSBmb3IgR2x1ZSBKb2JzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gICAgY29uc3QgZ2x1ZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgXCJHbHVlUm9sZVwiLCB7XG4gICAgICByb2xlTmFtZTogXCJQYXJ0eVN1cHBseUdsdWVSb2xlXCIsXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImdsdWUuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJzZXJ2aWNlLXJvbGUvQVdTR2x1ZVNlcnZpY2VSb2xlXCIpLFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIGdsdWVSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJzMzpHZXRPYmplY3RcIiwgXCJzMzpQdXRPYmplY3RcIiwgXCJzMzpEZWxldGVPYmplY3RcIiwgXCJzMzpMaXN0QnVja2V0XCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtiYXRjaEJ1Y2tldC5idWNrZXRBcm4sIGAke2JhdGNoQnVja2V0LmJ1Y2tldEFybn0vKmBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgZ2x1ZVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcInMzdmVjdG9yczpQdXRWZWN0b3JzXCIsXG4gICAgICAgICAgXCJzM3ZlY3RvcnM6R2V0VmVjdG9yc1wiLFxuICAgICAgICAgIFwiczN2ZWN0b3JzOkRlbGV0ZVZlY3RvcnNcIixcbiAgICAgICAgICBcInMzdmVjdG9yczpMaXN0VmVjdG9yc1wiLFxuICAgICAgICAgIFwiczN2ZWN0b3JzOlF1ZXJ5VmVjdG9yc1wiLFxuICAgICAgICAgIFwiczN2ZWN0b3JzOkdldEluZGV4XCIsXG4gICAgICAgICAgXCJzM3ZlY3RvcnM6TGlzdEluZGV4ZXNcIixcbiAgICAgICAgICBcInMzdmVjdG9yczpDcmVhdGVJbmRleFwiLFxuICAgICAgICAgIFwiczN2ZWN0b3JzOkRlbGV0ZUluZGV4XCIsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIGBhcm46YXdzOnMzdmVjdG9yczoke3JlZ2lvbn06JHthY2NvdW50fTpidWNrZXQvJHt2ZWN0b3JCdWNrZXROYW1lfWAsXG4gICAgICAgICAgYGFybjphd3M6czN2ZWN0b3JzOiR7cmVnaW9ufToke2FjY291bnR9OmJ1Y2tldC8ke3ZlY3RvckJ1Y2tldE5hbWV9L2luZGV4LypgLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8g4pSA4pSA4pSAIEdsdWUgSm9iOiBEZWR1cCAmIFByZXBhcmUgSlNPTkwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgICBjb25zdCBkZWR1cEpvYiA9IG5ldyBnbHVlLkNmbkpvYih0aGlzLCBcIkRlZHVwUHJlcGFyZUpvYlwiLCB7XG4gICAgICBuYW1lOiBcIlBhcnR5U3VwcGx5RGVkdXBQcmVwYXJlXCIsXG4gICAgICByb2xlOiBnbHVlUm9sZS5yb2xlQXJuLFxuICAgICAgY29tbWFuZDoge1xuICAgICAgICBuYW1lOiBcImdsdWVldGxcIixcbiAgICAgICAgc2NyaXB0TG9jYXRpb246IGBzMzovLyR7YmF0Y2hCdWNrZXQuYnVja2V0TmFtZX0vZ2x1ZS1zY3JpcHRzL2RlZHVwLXByZXBhcmUucHlgLFxuICAgICAgICBweXRob25WZXJzaW9uOiBcIjNcIixcbiAgICAgIH0sXG4gICAgICBkZWZhdWx0QXJndW1lbnRzOiB7XG4gICAgICAgIFwiLS1qb2ItbGFuZ3VhZ2VcIjogXCJweXRob25cIixcbiAgICAgICAgXCItLWVuYWJsZS1tZXRyaWNzXCI6IFwidHJ1ZVwiLFxuICAgICAgICBcIi0tVGVtcERpclwiOiBgczM6Ly8ke2JhdGNoQnVja2V0LmJ1Y2tldE5hbWV9L2dsdWUtdGVtcC9gLFxuICAgICAgfSxcbiAgICAgIGV4ZWN1dGlvblByb3BlcnR5OiB7XG4gICAgICAgIG1heENvbmN1cnJlbnRSdW5zOiAxMCxcbiAgICAgIH0sXG4gICAgICBnbHVlVmVyc2lvbjogXCI0LjBcIixcbiAgICAgIG51bWJlck9mV29ya2VyczogMixcbiAgICAgIHdvcmtlclR5cGU6IFwiRy4xWFwiLFxuICAgIH0pO1xuXG4gICAgLy8g4pSA4pSA4pSAIEdsdWUgSm9iOiBVcGxvYWQgVmVjdG9ycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAgIGNvbnN0IHVwbG9hZFZlY3RvcnNKb2IgPSBuZXcgZ2x1ZS5DZm5Kb2IodGhpcywgXCJVcGxvYWRWZWN0b3JzSm9iXCIsIHtcbiAgICAgIG5hbWU6IFwiUGFydHlTdXBwbHlVcGxvYWRWZWN0b3JzXCIsXG4gICAgICByb2xlOiBnbHVlUm9sZS5yb2xlQXJuLFxuICAgICAgY29tbWFuZDoge1xuICAgICAgICBuYW1lOiBcInB5dGhvbnNoZWxsXCIsXG4gICAgICAgIHNjcmlwdExvY2F0aW9uOiBgczM6Ly8ke2JhdGNoQnVja2V0LmJ1Y2tldE5hbWV9L2dsdWUtc2NyaXB0cy91cGxvYWQtdmVjdG9ycy5weWAsXG4gICAgICAgIHB5dGhvblZlcnNpb246IFwiMy45XCIsXG4gICAgICB9LFxuICAgICAgZGVmYXVsdEFyZ3VtZW50czoge1xuICAgICAgICBcIi0tam9iLWxhbmd1YWdlXCI6IFwicHl0aG9uXCIsXG4gICAgICAgIFwiLS1hZGRpdGlvbmFsLXB5dGhvbi1tb2R1bGVzXCI6IFwiYm90bzM+PTEuMjguMFwiLFxuICAgICAgfSxcbiAgICAgIGV4ZWN1dGlvblByb3BlcnR5OiB7XG4gICAgICAgIG1heENvbmN1cnJlbnRSdW5zOiAxMCxcbiAgICAgIH0sXG4gICAgICBtYXhDYXBhY2l0eTogMS4wLFxuICAgICAgdGltZW91dDogMTIwLFxuICAgIH0pO1xuXG4gICAgLy8g4pSA4pSA4pSAIElBTSBSb2xlIGZvciBMYW1iZGEgRnVuY3Rpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gICAgY29uc3QgbGFtYmRhUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBcIkxhbWJkYVJvbGVcIiwge1xuICAgICAgcm9sZU5hbWU6IFwiUGFydHlTdXBwbHlCYXRjaExhbWJkYVJvbGVcIixcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwibGFtYmRhLmFtYXpvbmF3cy5jb21cIiksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwic2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZVwiKSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICBsYW1iZGFSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJzMzpHZXRPYmplY3RcIiwgXCJzMzpQdXRPYmplY3RcIiwgXCJzMzpEZWxldGVPYmplY3RcIiwgXCJzMzpMaXN0QnVja2V0XCIsIFwiczM6Q29weU9iamVjdFwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6czM6OjpwYXJ0eS1zdXBwbHktYmF0Y2gtKmAsIGBhcm46YXdzOnMzOjo6cGFydHktc3VwcGx5LWJhdGNoLSovKmBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgbGFtYmRhUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwiYmVkcm9jazpDcmVhdGVNb2RlbEludm9jYXRpb25Kb2JcIixcbiAgICAgICAgICBcImJlZHJvY2s6R2V0TW9kZWxJbnZvY2F0aW9uSm9iXCIsXG4gICAgICAgICAgXCJiZWRyb2NrOkxpc3RNb2RlbEludm9jYXRpb25Kb2JzXCIsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIGxhbWJkYVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImlhbTpQYXNzUm9sZVwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6aWFtOjoke2FjY291bnR9OnJvbGUvUGFydHlTdXBwbHlCYXRjaEluZmVyZW5jZVJvbGVgXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIFMzIFZlY3RvcnMgcGVybWlzc2lvbnMgZm9yIGZsdXNoIChyZXBsYWNlIG1vZGUpXG4gICAgbGFtYmRhUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwiczN2ZWN0b3JzOkRlbGV0ZUluZGV4XCIsXG4gICAgICAgICAgXCJzM3ZlY3RvcnM6Q3JlYXRlSW5kZXhcIixcbiAgICAgICAgICBcInMzdmVjdG9yczpHZXRJbmRleFwiLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICBgYXJuOmF3czpzM3ZlY3RvcnM6JHtyZWdpb259OiR7YWNjb3VudH06YnVja2V0LyR7dmVjdG9yQnVja2V0TmFtZX1gLFxuICAgICAgICAgIGBhcm46YXdzOnMzdmVjdG9yczoke3JlZ2lvbn06JHthY2NvdW50fTpidWNrZXQvJHt2ZWN0b3JCdWNrZXROYW1lfS9pbmRleC8qYCxcbiAgICAgICAgXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIOKUgOKUgOKUgCBJQU0gUm9sZSBmb3IgQmVkcm9jayBCYXRjaCBJbmZlcmVuY2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgICBjb25zdCBiYXRjaEluZmVyZW5jZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgXCJCYXRjaEluZmVyZW5jZVJvbGVcIiwge1xuICAgICAgcm9sZU5hbWU6IFwiUGFydHlTdXBwbHlCYXRjaEluZmVyZW5jZVJvbGVcIixcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiYmVkcm9jay5hbWF6b25hd3MuY29tXCIpLFxuICAgIH0pO1xuXG4gICAgYmF0Y2hJbmZlcmVuY2VSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJzMzpHZXRPYmplY3RcIiwgXCJzMzpQdXRPYmplY3RcIiwgXCJzMzpMaXN0QnVja2V0XCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtiYXRjaEJ1Y2tldC5idWNrZXRBcm4sIGAke2JhdGNoQnVja2V0LmJ1Y2tldEFybn0vKmBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgYmF0Y2hJbmZlcmVuY2VSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJiZWRyb2NrOkludm9rZU1vZGVsXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpiZWRyb2NrOiR7cmVnaW9ufTo6Zm91bmRhdGlvbi1tb2RlbC9hbWF6b24udGl0YW4tZW1iZWQtdGV4dC12MjowYF0sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyDilIDilIDilIAgTGFtYmRhOiBTdWJtaXQgQmF0Y2ggSm9icyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAgIGNvbnN0IGxhbWJkYUNvZGVQYXRoID0gcGF0aC5qb2luKF9fZGlybmFtZSwgXCIuLi8uLi9zY3JpcHRzL2JhdGNoLXJlc3VsdC1sYW1iZGFcIik7XG5cbiAgICBjb25zdCBzdWJtaXRCYXRjaExhbWJkYSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJTdWJtaXRCYXRjaExhbWJkYVwiLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IFwiUGFydHlTdXBwbHlCYXRjaFN1Ym1pdFwiLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiBcInN1Ym1pdC1iYXRjaC5oYW5kbGVyXCIsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQobGFtYmRhQ29kZVBhdGgpLFxuICAgICAgcm9sZTogbGFtYmRhUm9sZSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEyMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBCQVRDSF9CVUNLRVQ6IGJhdGNoQnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICAgIEJBVENIX1JPTEVfQVJOOiBiYXRjaEluZmVyZW5jZVJvbGUucm9sZUFybixcbiAgICAgICAgTU9ERUxfSUQ6IFwiYW1hem9uLnRpdGFuLWVtYmVkLXRleHQtdjI6MFwiLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIOKUgOKUgOKUgCBMYW1iZGE6IENoZWNrIEJhdGNoIEpvYiBTdGF0dXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgICBjb25zdCBjaGVja0pvYnNMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiQ2hlY2tKb2JzTGFtYmRhXCIsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogXCJQYXJ0eVN1cHBseUJhdGNoQ2hlY2tKb2JzXCIsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6IFwiY2hlY2stam9icy5oYW5kbGVyXCIsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQobGFtYmRhQ29kZVBhdGgpLFxuICAgICAgcm9sZTogbGFtYmRhUm9sZSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEJBVENIX0JVQ0tFVDogYmF0Y2hCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyDilIDilIDilIAgTGFtYmRhOiBGbHVzaCBJbmRleCAoZm9yIHJlcGxhY2UgbW9kZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgICBjb25zdCBmbHVzaEluZGV4TGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkZsdXNoSW5kZXhMYW1iZGFcIiwge1xuICAgICAgZnVuY3Rpb25OYW1lOiBcIlBhcnR5U3VwcGx5QmF0Y2hGbHVzaEluZGV4XCIsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6IFwiZmx1c2gtaW5kZXguaGFuZGxlclwiLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KGxhbWJkYUNvZGVQYXRoKSxcbiAgICAgIHJvbGU6IGxhbWJkYVJvbGUsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBWRUNUT1JfQlVDS0VUOiB2ZWN0b3JCdWNrZXROYW1lLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIOKUgOKUgOKUgCBTdGVwIEZ1bmN0aW9ucyBTdGF0ZSBNYWNoaW5lIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gICAgLy8gU3RlcCAxOiBSdW4gR2x1ZSBFVEwgam9iIGZvciBkZWR1cGxpY2F0aW9uXG4gICAgY29uc3QgcnVuR2x1ZURlZHVwID0gbmV3IHRhc2tzLkdsdWVTdGFydEpvYlJ1bih0aGlzLCBcIlJ1bkdsdWVEZWR1cFwiLCB7XG4gICAgICBnbHVlSm9iTmFtZTogXCJQYXJ0eVN1cHBseURlZHVwUHJlcGFyZVwiLFxuICAgICAgaW50ZWdyYXRpb25QYXR0ZXJuOiBzZm4uSW50ZWdyYXRpb25QYXR0ZXJuLlJVTl9KT0IsXG4gICAgICBhcmd1bWVudHM6IHNmbi5UYXNrSW5wdXQuZnJvbU9iamVjdCh7XG4gICAgICAgIFwiLS1kYXRhX3R5cGVcIjogc2ZuLkpzb25QYXRoLnN0cmluZ0F0KFwiJC5kYXRhVHlwZVwiKSxcbiAgICAgICAgXCItLWlucHV0X3BhdGhcIjogc2ZuLkpzb25QYXRoLnN0cmluZ0F0KFwiJC5pbnB1dFBhdGhcIiksXG4gICAgICAgIFwiLS1vdXRwdXRfcGF0aFwiOiBzZm4uSnNvblBhdGguc3RyaW5nQXQoXCIkLm91dHB1dFBhdGhcIiksXG4gICAgICAgIFwiLS1jaHVua19zaXplXCI6IFwiNTAwMDBcIixcbiAgICAgIH0pLFxuICAgICAgcmVzdWx0UGF0aDogXCIkLmdsdWVSZXN1bHRcIixcbiAgICB9KTtcblxuICAgIC8vIFN0ZXAgMjogU3VibWl0IEJlZHJvY2sgQmF0Y2ggam9ic1xuICAgIGNvbnN0IHN1Ym1pdEJhdGNoSm9icyA9IG5ldyB0YXNrcy5MYW1iZGFJbnZva2UodGhpcywgXCJTdWJtaXRCYXRjaEpvYnNcIiwge1xuICAgICAgbGFtYmRhRnVuY3Rpb246IHN1Ym1pdEJhdGNoTGFtYmRhLFxuICAgICAgcGF5bG9hZDogc2ZuLlRhc2tJbnB1dC5mcm9tT2JqZWN0KHtcbiAgICAgICAgZGF0YVR5cGU6IHNmbi5Kc29uUGF0aC5zdHJpbmdBdChcIiQuZGF0YVR5cGVcIiksXG4gICAgICAgIHByZXBhcmVkUGF0aDogc2ZuLkpzb25QYXRoLnN0cmluZ0F0KFwiJC5vdXRwdXRQYXRoXCIpLFxuICAgICAgICB1cGxvYWRNb2RlOiBzZm4uSnNvblBhdGguc3RyaW5nQXQoXCIkLnVwbG9hZE1vZGVcIiksXG4gICAgICB9KSxcbiAgICAgIHJlc3VsdFNlbGVjdG9yOiB7XG4gICAgICAgIFwiam9iQ291bnQuJFwiOiBcIiQuUGF5bG9hZC5qb2JDb3VudFwiLFxuICAgICAgICBcIm1hbmlmZXN0TmFtZS4kXCI6IFwiJC5QYXlsb2FkLm1hbmlmZXN0TmFtZVwiLFxuICAgICAgICBcImpvYnMuJFwiOiBcIiQuUGF5bG9hZC5qb2JzXCIsXG4gICAgICB9LFxuICAgICAgcmVzdWx0UGF0aDogXCIkLmJhdGNoUmVzdWx0XCIsXG4gICAgfSk7XG5cbiAgICAvLyBTdGVwIDM6IENoZWNrIGJhdGNoIGpvYiBzdGF0dXNcbiAgICBjb25zdCBjaGVja0JhdGNoU3RhdHVzID0gbmV3IHRhc2tzLkxhbWJkYUludm9rZSh0aGlzLCBcIkNoZWNrQmF0Y2hTdGF0dXNcIiwge1xuICAgICAgbGFtYmRhRnVuY3Rpb246IGNoZWNrSm9ic0xhbWJkYSxcbiAgICAgIHBheWxvYWQ6IHNmbi5UYXNrSW5wdXQuZnJvbU9iamVjdCh7XG4gICAgICAgIGpvYnM6IHNmbi5Kc29uUGF0aC5zdHJpbmdBdChcIiQuYmF0Y2hSZXN1bHQuam9ic1wiKSxcbiAgICAgIH0pLFxuICAgICAgcmVzdWx0U2VsZWN0b3I6IHtcbiAgICAgICAgXCJhbGxDb21wbGV0ZS4kXCI6IFwiJC5QYXlsb2FkLmFsbENvbXBsZXRlXCIsXG4gICAgICAgIFwiYW55RmFpbGVkLiRcIjogXCIkLlBheWxvYWQuYW55RmFpbGVkXCIsXG4gICAgICAgIFwic3RhdHVzLiRcIjogXCIkLlBheWxvYWQuc3RhdHVzXCIsXG4gICAgICB9LFxuICAgICAgcmVzdWx0UGF0aDogXCIkLmNoZWNrUmVzdWx0XCIsXG4gICAgfSk7XG5cbiAgICAvLyBXYWl0IHN0YXRlIGZvciBwb2xsaW5nXG4gICAgY29uc3Qgd2FpdEZvckJhdGNoID0gbmV3IHNmbi5XYWl0KHRoaXMsIFwiV2FpdEZvckJhdGNoXCIsIHtcbiAgICAgIHRpbWU6IHNmbi5XYWl0VGltZS5kdXJhdGlvbihjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCkpLFxuICAgIH0pO1xuXG4gICAgLy8gU3RlcCA0OiBGbHVzaCBpbmRleCAoZm9yIHJlcGxhY2UgbW9kZSlcbiAgICBjb25zdCBmbHVzaEluZGV4ID0gbmV3IHRhc2tzLkxhbWJkYUludm9rZSh0aGlzLCBcIkZsdXNoSW5kZXhcIiwge1xuICAgICAgbGFtYmRhRnVuY3Rpb246IGZsdXNoSW5kZXhMYW1iZGEsXG4gICAgICBwYXlsb2FkOiBzZm4uVGFza0lucHV0LmZyb21PYmplY3Qoe1xuICAgICAgICBkYXRhVHlwZTogc2ZuLkpzb25QYXRoLnN0cmluZ0F0KFwiJC5kYXRhVHlwZVwiKSxcbiAgICAgIH0pLFxuICAgICAgcmVzdWx0UGF0aDogXCIkLmZsdXNoUmVzdWx0XCIsXG4gICAgfSk7XG5cbiAgICAvLyBTdGVwIDU6IFJ1biBHbHVlIHVwbG9hZCBqb2JzIChvbmUgcGVyIGNodW5rKVxuICAgIC8vIFBhdGhzIGFyZSBjb25zdHJ1Y3RlZCB1c2luZyBTdGF0ZXMuRm9ybWF0IGludHJpbnNpYyBmdW5jdGlvblxuICAgIGNvbnN0IHJ1bkdsdWVVcGxvYWQgPSBuZXcgdGFza3MuR2x1ZVN0YXJ0Sm9iUnVuKHRoaXMsIFwiUnVuR2x1ZVVwbG9hZFwiLCB7XG4gICAgICBnbHVlSm9iTmFtZTogXCJQYXJ0eVN1cHBseVVwbG9hZFZlY3RvcnNcIixcbiAgICAgIGludGVncmF0aW9uUGF0dGVybjogc2ZuLkludGVncmF0aW9uUGF0dGVybi5SVU5fSk9CLFxuICAgICAgYXJndW1lbnRzOiBzZm4uVGFza0lucHV0LmZyb21PYmplY3Qoe1xuICAgICAgICBcIi0tZGF0YV90eXBlXCI6IHNmbi5Kc29uUGF0aC5zdHJpbmdBdChcIiQuZGF0YVR5cGVcIiksXG4gICAgICAgIFwiLS1iYXRjaF9vdXRwdXRfcGF0aFwiOiBzZm4uSnNvblBhdGguZm9ybWF0KFwiczM6Ly97fS97fS9cIiwgc2ZuLkpzb25QYXRoLnN0cmluZ0F0KFwiJC5idWNrZXROYW1lXCIpLCBzZm4uSnNvblBhdGguc3RyaW5nQXQoXCIkLm91dHB1dFByZWZpeFwiKSksXG4gICAgICAgIFwiLS1yYXdfZGF0YV9wYXRoXCI6IHNmbi5Kc29uUGF0aC5mb3JtYXQoXCJ7fXJhdy9cIiwgc2ZuLkpzb25QYXRoLnN0cmluZ0F0KFwiJC5vdXRwdXRQYXRoXCIpKSxcbiAgICAgICAgXCItLXZlY3Rvcl9idWNrZXRcIjogdmVjdG9yQnVja2V0TmFtZSxcbiAgICAgICAgXCItLXJlZ2lvblwiOiByZWdpb24sXG4gICAgICAgIFwiLS11cGxvYWRfbW9kZVwiOiBcInVwc2VydFwiLFxuICAgICAgfSksXG4gICAgICByZXN1bHRQYXRoOiBcIiQudXBsb2FkUmVzdWx0XCIsXG4gICAgfSk7XG5cbiAgICAvLyBNYXAgc3RhdGUgdG8gcHJvY2VzcyBlYWNoIGJhdGNoIGpvYiBvdXRwdXRcbiAgICBjb25zdCBwcm9jZXNzQ2h1bmtzID0gbmV3IHNmbi5NYXAodGhpcywgXCJQcm9jZXNzQ2h1bmtzXCIsIHtcbiAgICAgIGl0ZW1zUGF0aDogXCIkLmJhdGNoUmVzdWx0LmpvYnNcIixcbiAgICAgIGl0ZW1TZWxlY3Rvcjoge1xuICAgICAgICBcImRhdGFUeXBlLiRcIjogXCIkLmRhdGFUeXBlXCIsXG4gICAgICAgIFwib3V0cHV0UGF0aC4kXCI6IFwiJC5vdXRwdXRQYXRoXCIsXG4gICAgICAgIFwidXBsb2FkTW9kZS4kXCI6IFwiJC51cGxvYWRNb2RlXCIsXG4gICAgICAgIFwiYnVja2V0TmFtZVwiOiBidWNrZXROYW1lLFxuICAgICAgICBcIm91dHB1dFByZWZpeC4kXCI6IFwiJCQuTWFwLkl0ZW0uVmFsdWUub3V0cHV0UHJlZml4XCIsXG4gICAgICB9LFxuICAgICAgbWF4Q29uY3VycmVuY3k6IDMsXG4gICAgICByZXN1bHRQYXRoOiBcIiQudXBsb2FkUmVzdWx0c1wiLFxuICAgIH0pO1xuICAgIHByb2Nlc3NDaHVua3MuaXRlbVByb2Nlc3NvcihydW5HbHVlVXBsb2FkKTtcblxuICAgIC8vIFN1Y2Nlc3Mgc3RhdGVcbiAgICBjb25zdCBzdWNjZXNzU3RhdGUgPSBuZXcgc2ZuLlN1Y2NlZWQodGhpcywgXCJJbXBvcnRDb21wbGV0ZVwiLCB7XG4gICAgICBjb21tZW50OiBcIkJhdGNoIGltcG9ydCBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5XCIsXG4gICAgfSk7XG5cbiAgICAvLyBGYWlsdXJlIHN0YXRlXG4gICAgY29uc3QgZmFpbHVyZVN0YXRlID0gbmV3IHNmbi5GYWlsKHRoaXMsIFwiSW1wb3J0RmFpbGVkXCIsIHtcbiAgICAgIGNhdXNlOiBcIk9uZSBvciBtb3JlIGJhdGNoIGpvYnMgZmFpbGVkXCIsXG4gICAgICBlcnJvcjogXCJCYXRjaEpvYkZhaWxlZFwiLFxuICAgIH0pO1xuXG4gICAgLy8gU2tpcCBmbHVzaCBmb3Igbm9uLXJlcGxhY2UgbW9kZVxuICAgIGNvbnN0IHNraXBGbHVzaCA9IG5ldyBzZm4uUGFzcyh0aGlzLCBcIlNraXBGbHVzaFwiLCB7XG4gICAgICByZXN1bHRQYXRoOiBcIiQuZmx1c2hSZXN1bHRcIixcbiAgICB9KTtcblxuICAgIC8vIENob2ljZTogY2hlY2sgaWYgcmVwbGFjZSBtb2RlXG4gICAgY29uc3QgY2hlY2tSZXBsYWNlTW9kZSA9IG5ldyBzZm4uQ2hvaWNlKHRoaXMsIFwiQ2hlY2tSZXBsYWNlTW9kZVwiKVxuICAgICAgLndoZW4oc2ZuLkNvbmRpdGlvbi5zdHJpbmdFcXVhbHMoXCIkLnVwbG9hZE1vZGVcIiwgXCJyZXBsYWNlXCIpLCBmbHVzaEluZGV4Lm5leHQocHJvY2Vzc0NodW5rcykpXG4gICAgICAub3RoZXJ3aXNlKHNraXBGbHVzaC5uZXh0KHByb2Nlc3NDaHVua3MpKTtcblxuICAgIC8vIENob2ljZTogY2hlY2sgaWYgYWxsIGpvYnMgY29tcGxldGVcbiAgICBjb25zdCBjaGVja0NvbXBsZXRlID0gbmV3IHNmbi5DaG9pY2UodGhpcywgXCJDaGVja0NvbXBsZXRlXCIpXG4gICAgICAud2hlbihzZm4uQ29uZGl0aW9uLmJvb2xlYW5FcXVhbHMoXCIkLmNoZWNrUmVzdWx0LmFueUZhaWxlZFwiLCB0cnVlKSwgZmFpbHVyZVN0YXRlKVxuICAgICAgLndoZW4oc2ZuLkNvbmRpdGlvbi5ib29sZWFuRXF1YWxzKFwiJC5jaGVja1Jlc3VsdC5hbGxDb21wbGV0ZVwiLCB0cnVlKSwgY2hlY2tSZXBsYWNlTW9kZSlcbiAgICAgIC5vdGhlcndpc2Uod2FpdEZvckJhdGNoLm5leHQoY2hlY2tCYXRjaFN0YXR1cykpO1xuXG4gICAgLy8gQnVpbGQgdGhlIHN0YXRlIG1hY2hpbmVcbiAgICBjb25zdCBkZWZpbml0aW9uID0gcnVuR2x1ZURlZHVwXG4gICAgICAubmV4dChzdWJtaXRCYXRjaEpvYnMpXG4gICAgICAubmV4dChjaGVja0JhdGNoU3RhdHVzKVxuICAgICAgLm5leHQoY2hlY2tDb21wbGV0ZSk7XG5cbiAgICBwcm9jZXNzQ2h1bmtzLm5leHQoc3VjY2Vzc1N0YXRlKTtcblxuICAgIGNvbnN0IHN0YXRlTWFjaGluZSA9IG5ldyBzZm4uU3RhdGVNYWNoaW5lKHRoaXMsIFwiQmF0Y2hJbXBvcnRTdGF0ZU1hY2hpbmVcIiwge1xuICAgICAgc3RhdGVNYWNoaW5lTmFtZTogXCJQYXJ0eVN1cHBseUJhdGNoSW1wb3J0XCIsXG4gICAgICBkZWZpbml0aW9uQm9keTogc2ZuLkRlZmluaXRpb25Cb2R5LmZyb21DaGFpbmFibGUoZGVmaW5pdGlvbiksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uaG91cnMoNCksXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCBTdGVwIEZ1bmN0aW9ucyBwZXJtaXNzaW9uIHRvIGludm9rZSBHbHVlXG4gICAgc3RhdGVNYWNoaW5lLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wiZ2x1ZTpTdGFydEpvYlJ1blwiLCBcImdsdWU6R2V0Sm9iUnVuXCIsIFwiZ2x1ZTpHZXRKb2JSdW5zXCIsIFwiZ2x1ZTpCYXRjaFN0b3BKb2JSdW5cIl0sXG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIGBhcm46YXdzOmdsdWU6JHtyZWdpb259OiR7YWNjb3VudH06am9iL1BhcnR5U3VwcGx5RGVkdXBQcmVwYXJlYCxcbiAgICAgICAgICBgYXJuOmF3czpnbHVlOiR7cmVnaW9ufToke2FjY291bnR9OmpvYi9QYXJ0eVN1cHBseVVwbG9hZFZlY3RvcnNgLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8g4pSA4pSA4pSAIE91dHB1dHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIkJhdGNoQnVja2V0TmFtZVwiLCB7XG4gICAgICB2YWx1ZTogYmF0Y2hCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlMzIGJ1Y2tldCBmb3IgYmF0Y2ggam9iIEkvT1wiLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJTdGF0ZU1hY2hpbmVBcm5cIiwge1xuICAgICAgdmFsdWU6IHN0YXRlTWFjaGluZS5zdGF0ZU1hY2hpbmVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogXCJTdGVwIEZ1bmN0aW9ucyBzdGF0ZSBtYWNoaW5lIEFSTlwiLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJHbHVlRGVkdXBKb2JOYW1lXCIsIHtcbiAgICAgIHZhbHVlOiBkZWR1cEpvYi5uYW1lISxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkdsdWUgRVRMIGpvYiBmb3IgZGVkdXBsaWNhdGlvblwiLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJHbHVlVXBsb2FkSm9iTmFtZVwiLCB7XG4gICAgICB2YWx1ZTogdXBsb2FkVmVjdG9yc0pvYi5uYW1lISxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkdsdWUgUHl0aG9uIFNoZWxsIGpvYiBmb3IgdmVjdG9yIHVwbG9hZFwiLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJTdWJtaXRCYXRjaExhbWJkYUFyblwiLCB7XG4gICAgICB2YWx1ZTogc3VibWl0QmF0Y2hMYW1iZGEuZnVuY3Rpb25Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogXCJMYW1iZGEgdG8gc3VibWl0IEJlZHJvY2sgQmF0Y2ggam9ic1wiLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJCYXRjaEluZmVyZW5jZVJvbGVBcm5cIiwge1xuICAgICAgdmFsdWU6IGJhdGNoSW5mZXJlbmNlUm9sZS5yb2xlQXJuLFxuICAgICAgZGVzY3JpcHRpb246IFwiSUFNIHJvbGUgZm9yIEJlZHJvY2sgQmF0Y2ggSW5mZXJlbmNlXCIsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==