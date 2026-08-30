import assert from "node:assert/strict";
import test from "node:test";
import { BotStore } from "../src/store.js";

test("admin invitations are hashed, single-use, expiring, and revocable",()=>{
  const store=new BotStore();
  try {
    const token=store.createAdminInvite("100",600,1_000),storedHash=store.inviteHashForTest(token);
    assert.ok(token.length>=20);
    assert.notEqual(storedHash,token);
    assert.equal(store.claimAdminInvite("not-a-valid-token","200","alice",1_001),"invalid");
    assert.equal(store.claimAdminInvite(token,"200","alice",1_001),"claimed");
    assert.equal(store.isAdmin("200"),true);
    assert.equal(store.claimAdminInvite(token,"201","bob",1_002),"used");
    assert.deepEqual(store.adminRows().map(row=>({id:row.user_id,username:row.username})),[{id:"200",username:"alice"}]);
    assert.equal(store.revokeAdmin("200"),true);
    assert.equal(store.isAdmin("200"),false);
    const expired=store.createAdminInvite("100",300,2_000);
    assert.equal(store.claimAdminInvite(expired,"202",undefined,2_301),"expired");
  } finally {void store.close();}
});
