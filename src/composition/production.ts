import { Effect, Layer } from "effect";
import { DeploymentUnavailable, JobControl } from "../application/services.js";

const unavailable = () =>
  Effect.fail(
    new DeploymentUnavailable({
      message: "Deployment unavailable: no production Deployment adapter is configured",
    }),
  );

export const ProductionJobControl = Layer.effect(
  JobControl,
  Effect.succeed({
    submit: unavailable,
    get: unavailable,
    watch: unavailable,
  }),
);
