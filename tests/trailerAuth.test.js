'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const jwt=require('jsonwebtoken');
const{createAuthMiddleware,requirePermission,requireAllPermissions}=require('../server/middleware/auth');
function response(){return{statusCode:200,body:null,status(code){this.statusCode=code;return this},json(body){this.body=body;return this}}}
async function invoke(middleware,req){const res=response();let next=false;await middleware(req,res,()=>{next=true});return{res,next}}
test('auth reloads active roles and permissions on every request',async()=>{
  let permissions=['trailers.view'];const db={getAdminAuthorization:async()=>({id:1,username:'Trailer',active:true,auth_version:3,role_keys:['trailer_viewer'],permissions})};
  const token=jwt.sign({id:1,username:'Trailer',auth_version:3},'secret',{algorithm:'HS256'});const middleware=createAuthMiddleware({jwtSecret:'secret'},db);
  const first=await invoke(middleware,{headers:{authorization:`Bearer ${token}`}});assert.equal(first.next,true);assert.deepEqual(first.res.body,null);
  permissions=[];const req={headers:{authorization:`Bearer ${token}`}};const authenticated=await invoke(middleware,req);assert.equal(authenticated.next,true);
  const denied=await invoke(requirePermission('trailers.view'),req);assert.equal(denied.next,false);assert.equal(denied.res.statusCode,403);
});
test('disabled accounts and stale auth versions are rejected immediately',async()=>{
  const token=jwt.sign({id:1,username:'Trailer',auth_version:1},'secret',{algorithm:'HS256'});
  let account={id:1,active:false,auth_version:1,permissions:[]};const middleware=createAuthMiddleware({jwtSecret:'secret'},{getAdminAuthorization:async()=>account});
  assert.equal((await invoke(middleware,{headers:{authorization:`Bearer ${token}`}})).res.statusCode,401);
  account={...account,active:true,auth_version:2};assert.equal((await invoke(middleware,{headers:{authorization:`Bearer ${token}`}})).res.statusCode,401);
});
test('permission helpers implement any and all semantics',async()=>{
  const req={admin:{permissions:['a','b']}};assert.equal((await invoke(requirePermission('x','a'),req)).next,true);
  assert.equal((await invoke(requireAllPermissions('a','b'),req)).next,true);
  assert.equal((await invoke(requireAllPermissions('a','c'),req)).res.statusCode,403);
});
