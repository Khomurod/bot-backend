'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const guards = require('./adminUserGuards');

function status(error){return error.status||(/duplicate key|unique constraint/i.test(error.message)?409:500);}
// A refusal we raised carries its message and machine-readable code (e.g.
// USERNAME_TAKEN); anything else gets the generic line, so a database
// error's own text never reaches the page.
function errorBody(error,fallback){return error.status?{error:error.message,...(error.code?{code:error.code}:{})}:{error:fallback};}

function createAdminUserRoutes({db,authMiddleware,requirePermission}){
  const router=express.Router();
  const canManageUsers=requirePermission('users.manage');

  // The catalog rows for the requested ids; refuses an id that names no role.
  async function validateAssignableRoles(roleIds){
    const catalog=await db.listRolesAndPermissions();
    const selected=catalog.roles.filter((role)=>roleIds.map(Number).includes(Number(role.id)));
    if(selected.length!==new Set(roleIds.map(Number)).size)throw Object.assign(new Error('One or more roles do not exist.'),{status:400});
    return selected;
  }

  router.get('/api/admin/users',authMiddleware,canManageUsers,async(req,res)=>{
    try{res.json({users:await db.listAdminUsers()});}catch(e){res.status(500).json({error:'Failed to load users.'});}
  });
  router.get('/api/admin/roles',authMiddleware,canManageUsers,async(req,res)=>{
    try{res.json(await db.listRolesAndPermissions());}catch(e){res.status(500).json({error:'Failed to load roles.'});}
  });
  router.post('/api/admin/users',authMiddleware,canManageUsers,async(req,res)=>{
    try{
      const{username,password,role_ids:roleIds=[]}=req.body||{};
      if(!String(username||'').trim()||String(password||'').length<10||!Array.isArray(roleIds)){
        return res.status(400).json({error:'Username, password of at least 10 characters, and roles are required.'});
      }
      // An empty list reaches the guard, so it answers ROLE_REQUIRED here too.
      guards.assertRoleChangeAllowed({actor:req.admin,selectedRoles:await validateAssignableRoles(roleIds)});
      const user=await db.createAdminUser({username,passwordHash:await bcrypt.hash(password,12),roleIds,actorId:req.admin.id});
      res.status(201).json({user});
    }catch(e){res.status(status(e)).json(errorBody(e,'Could not create user.'));}
  });
  router.put('/api/admin/users/:id',authMiddleware,canManageUsers,async(req,res)=>{
    try{
      const body=req.body||{}; const roleIds=body.role_ids;
      const users=await db.listAdminUsers();
      const target=guards.resolveTargetOr404(users,req.params.id);
      // No role-less account, and only a super administrator moves super_admin.
      if(roleIds!=null&&!Array.isArray(roleIds))return res.status(400).json({error:'role_ids must be a list.'});
      guards.assertRoleChangeAllowed({actor:req.admin,target,roleIdsGiven:Array.isArray(roleIds),
        selectedRoles:Array.isArray(roleIds)?await validateAssignableRoles(roleIds):[]});
      // The last active super administrator cannot be deactivated or demoted.
      guards.assertSuperAdminFloor(users,target,{nextRoleIds:roleIds,nextActive:body.active});
      const passwordHash=body.password?await bcrypt.hash(String(body.password),12):null;
      if(body.password&&String(body.password).length<10)return res.status(400).json({error:'Password must be at least 10 characters.'});
      const user=await db.updateAdminUser(req.params.id,{username:body.username,active:body.active,roleIds,passwordHash,actorId:req.admin.id});
      res.json({user});
    }catch(e){res.status(status(e)).json(errorBody(e,'Could not update user.'));}
  });
  router.post('/api/admin/roles',authMiddleware,requirePermission('roles.manage'),async(req,res)=>{
    try{
      const{display_name:displayName,description,permission_keys:permissionKeys=[]}=req.body||{};
      if(!String(displayName||'').trim()||!Array.isArray(permissionKeys))return res.status(400).json({error:'Role name and permission list are required.'});
      res.status(201).json({role:await db.createRole({displayName,description,permissionKeys,actorId:req.admin.id})});
    }catch(e){res.status(status(e)).json({error:e.status?e.message:'Could not create role.'});}
  });
  router.put('/api/admin/roles/:id',authMiddleware,requirePermission('roles.manage'),async(req,res)=>{
    try{
      const b=req.body||{};
      const role=await db.updateRole(req.params.id,{displayName:b.display_name,description:b.description,
        active:b.active,permissionKeys:b.permission_keys,version:b.version,actorId:req.admin.id});
      if(!role)return res.status(404).json({error:'Role not found.'});
      res.json({role});
    }catch(e){res.status(status(e)).json({error:e.status?e.message:'Could not update role.'});}
  });
  return router;
}

module.exports={createAdminUserRoutes};
