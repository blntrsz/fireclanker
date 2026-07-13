import * as AWS from "alchemy/AWS";
import { LOG_GROUP_NAME, REGION } from "./constants.ts";

export const MicrovmExecutionRole = AWS.IAM.Role("FireclankerPrototypeMicrovmExecutionRole", {
  roleName: "fireclanker-wayfinder-microvm-execution",
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: ["sts:AssumeRole", "sts:TagSession"],
      },
    ],
  },
  inlinePolicies: {
    "microvm-runtime-logs": {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"],
          Resource: [`arn:aws:logs:${REGION}:*:log-group:${LOG_GROUP_NAME}:*`],
        },
      ],
    },
  },
  tags: { purpose: "fireclanker-wayfinder-prototype" },
});
