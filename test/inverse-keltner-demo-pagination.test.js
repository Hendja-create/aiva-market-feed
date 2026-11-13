import test from "node:test";
import assert from "node:assert/strict";
import { loadRecentQuoteTicks, isFreshTickTimestamp, isExactlyNextM5Candle } from "../src/inverse-keltner-demo.js";

function makeRows(count) {
  return Array.from({length:count},(_,i)=>{
    const id=i+1;
    const timestamp=new Date(Date.UTC(2026,10,13,0,0,id)).toISOString();
    return {id:String(id),bid:2600+i/100,ask:2600.3+i/100,
      provider_timestamp:timestamp,received_at:timestamp};
  });
}

test("loads recent ticks in stable ID pages and returns them chronologically",async()=>{
  const source=makeRows(2501);
  const calls=[];
  const db=async path=>{
    calls.push(path);
    const query=new URLSearchParams(path.split("?")[1]);
    const cursor=query.get("id");
    const before=cursor?BigInt(cursor.slice(3)):null;
    const limit=Number(query.get("limit"));
    return source.filter(row=>before===null||BigInt(row.id)<before)
      .sort((a,b)=>Number(b.id)-Number(a.id)).slice(0,limit);
  };
  const result=await loadRecentQuoteTicks(db,"XAUUSD",2500,1000);
  assert.equal(result.rows.length,2500);
  assert.equal(result.pages,3);
  assert.equal(result.reached_limit,true);
  assert.equal(calls.length,3);
  assert.equal(result.rows[0].id,"2");
  assert.equal(result.rows.at(-1).id,"2501");
  assert.match(calls[1],/id=lt\.1502/);
});

test("fails closed if the pagination cursor does not advance",async()=>{
  const page=makeRows(1000).reverse();
  const db=async()=>page;
  await assert.rejects(
    loadRecentQuoteTicks(db,"XAUUSD",2000,1000),
    /pagination cursor did not advance/
  );
});

test("rejects stale or future provider ticks outside the allowed clock skew",()=>{
  const now=Date.parse("2026-11-13T07:50:00.000Z");
  assert.equal(isFreshTickTimestamp("2026-11-13T07:49:30.000Z",now),true);
  assert.equal(isFreshTickTimestamp("2026-11-13T07:48:00.000Z",now),false);
  assert.equal(isFreshTickTimestamp("2026-11-13T07:52:00.000Z",now),false);
});

test("accepts only the immediately next M5 candle for a new signal",()=>{
  const previous="2026-11-13T07:40:00.000Z";
  assert.equal(isExactlyNextM5Candle(previous,"2026-11-13T07:45:00.000Z"),true);
  assert.equal(isExactlyNextM5Candle(previous,"2026-11-13T07:50:00.000Z"),false);
  assert.equal(isExactlyNextM5Candle(previous,"2026-11-13T02:00:00.000Z"),false);
});
