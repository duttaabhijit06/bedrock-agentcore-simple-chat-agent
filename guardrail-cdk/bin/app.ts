#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { GuardrailStack } from "../lib/guardrail-stack";

const app = new cdk.App();

new GuardrailStack(app, "PartySupply-Guardrail", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-west-2",
  },
  description: "Bedrock Guardrail for Party Supply Chat Agent",
});
