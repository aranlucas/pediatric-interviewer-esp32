import { routeAgentRequest } from "agents";
import { createWorker } from "./edge-handler";

export { PediatricInterviewer } from "./interviewer";

export default createWorker<Env>(routeAgentRequest);
