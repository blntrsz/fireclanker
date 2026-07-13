import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Core";
import Stack from "./alchemy.run.ts";

const action = process.argv[2];
if (action !== "deploy" && action !== "destroy") {
  throw new Error("usage: bun alchemy-cli.ts <deploy|destroy>");
}

const options = {
  providers: AWS.providers(),
  state: Alchemy.localState(),
  profile: "default",
  stage: "wayfinder",
};

const operation = action === "deploy" ? Test.deploy(options, Stack) : Test.destroy(options, Stack);

await Test.run(operation, options);
