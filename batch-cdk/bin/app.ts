#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BatchProcessingStack } from "../lib/batch-processing-stack";

const app = new cdk.App();

new BatchProcessingStack(app, "PartySupplyBatchStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || "us-west-2",
  },
  description: "Party Supply batch processing infrastructure (Glue, Lambda, Step Functions)",
});
