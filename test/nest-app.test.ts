import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { AlertStream } from "../src/alert-stream.js";
import { AppController } from "../src/app.controller.js";
import { RuntimeService } from "../src/runtime.service.js";

test("NestJS resolves the API controller through dependency injection",async()=>{
  const runtime={config:{default_chain:"sol",enabled_chains:["sol","bsc","robinhood"]},scheduledChains:["sol","bsc","robinhood"],tracker:{roster:()=>[],alerts:()=>[]},botStore:{}};
  const module=await Test.createTestingModule({controllers:[AppController],providers:[AlertStream,{provide:RuntimeService,useValue:runtime}]}).compile();
  try {
    const controller=module.get(AppController);
    assert.deepEqual(controller.health(),{ok:true,chains:["sol","bsc","robinhood"],database:"mongodb"});
    assert.deepEqual(controller.chains(),{chains:["sol","bsc","robinhood"],default:"sol"});
  } finally {await module.close();}
});
