import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as glue from "aws-cdk-lib/aws-glue";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import * as path from "path";

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
export class BatchProcessingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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

    glueRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
        resources: [batchBucket.bucketArn, `${batchBucket.bucketArn}/*`],
      })
    );

    glueRole.addToPolicy(
      new iam.PolicyStatement({
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
      })
    );

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

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:CopyObject"],
        resources: [`arn:aws:s3:::party-supply-batch-*`, `arn:aws:s3:::party-supply-batch-*/*`],
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:CreateModelInvocationJob",
          "bedrock:GetModelInvocationJob",
          "bedrock:ListModelInvocationJobs",
        ],
        resources: ["*"],
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [`arn:aws:iam::${account}:role/PartySupplyBatchInferenceRole`],
      })
    );

    // S3 Vectors permissions for flush (replace mode)
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3vectors:DeleteIndex",
          "s3vectors:CreateIndex",
          "s3vectors:GetIndex",
        ],
        resources: [
          `arn:aws:s3vectors:${region}:${account}:bucket/${vectorBucketName}`,
          `arn:aws:s3vectors:${region}:${account}:bucket/${vectorBucketName}/index/*`,
        ],
      })
    );

    // ─── IAM Role for Bedrock Batch Inference ───────────────────────────────

    const batchInferenceRole = new iam.Role(this, "BatchInferenceRole", {
      roleName: "PartySupplyBatchInferenceRole",
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
    });

    batchInferenceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
        resources: [batchBucket.bucketArn, `${batchBucket.bucketArn}/*`],
      })
    );

    batchInferenceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [`arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`],
      })
    );

    // ─── Lambda: Submit Batch Jobs ──────────────────────────────────────────

    const lambdaCodePath = path.join(__dirname, "../../scripts/batch-result-lambda");

    const submitBatchLambda = new lambda.Function(this, "SubmitBatchLambda", {
      functionName: "PartySupplyBatchSubmit",
      runtime: lambda.Runtime.NODEJS_24_X,
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
      runtime: lambda.Runtime.NODEJS_24_X,
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
      runtime: lambda.Runtime.NODEJS_24_X,
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
    stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["glue:StartJobRun", "glue:GetJobRun", "glue:GetJobRuns", "glue:BatchStopJobRun"],
        resources: [
          `arn:aws:glue:${region}:${account}:job/PartySupplyDedupPrepare`,
          `arn:aws:glue:${region}:${account}:job/PartySupplyUploadVectors`,
        ],
      })
    );

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
      value: dedupJob.name!,
      description: "Glue ETL job for deduplication",
    });

    new cdk.CfnOutput(this, "GlueUploadJobName", {
      value: uploadVectorsJob.name!,
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
