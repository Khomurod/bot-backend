'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const scope = require('./adminUserScope');

function has(req, permission){return new Set(req.admin?.permissions||[]).has(permission);}
function status(error){return error.status||(/duplicate key|unique constraint/i.test(error.message)?409:500);}

function createAdminUserRoutes({db,authMiddleware,requirePermission}){
  const router=express.Router();
  const canManageUsers=requirePermission('users.manage','trailer_users.manage');

  async function validateAssignableRoles(req,roleIds){
    const catalog=await db.listRolesAndPermissions();
    const selected=catalog.roles.filter((role)=>roleIds.map(Number).includes(Number(role.id)));
    if(selected.length!==new Set(roleIds.map(Number)).size)throw Object.assign(new Error('One or more roles do not exist.'),{status:400});
    if(!has(req,'users.manage')&&selected.some((role)=>!String(role.system_key||'').startsWith('trailer_'))){
      throw Object.assign(new Error('Trailer managers may assign only Trailer Department roles.'),{status:403});
    }
  }

  router.get('/api/admin/users',authMiddleware,canManageUsers,async(req,res)=>{
    // A Trailer Manager sees ONLY trailer-scoped accounts — super admins and
    // unrelated admins are invisible, so their existence cannot be inferred.
    try{res.json({users:scope.visibleUsers(req,await db.listAdminUsers())});}catch(e){res.status(500).json({error:'Failed to load users.'});}
  });
  router.get('/api/admin/roles',authMiddleware,canManageUsers,async(req,res)=>{
    try{res.json(await db.listRolesAndPermissions());}catch(e){res.status(500).json({error:'Failed to load roles.'});}
  });
  router.post('/api/admin/users',authMiddleware,canManageUsers,async(req,res)=>{
    try{
      const{username,password,role_ids:roleIds=[]}=req.body||{};
      if(!String(username||'').trim()||String(password||'').length<10||!Array.isArray(roleIds)||!roleIds.length){
        return res.status(400).json({error:'Username, password of at least 10 characters, and roles are required.'});
      }
      await validateAssignableRoles(req,roleIds);
      const user=await db.createAdminUser({username,passwordHash:await bcrypt.hash(password,12),roleIds,actorId:req.admin.id});
      res.status(201).json({user});
    }catch(e){res.status(status(e)).json({error:e.status?e.message:'Could not create user.'});}
  });
  router.put('/api/admin/users/:id',authMiddleware,canManageUsers,async(req,res)=>{
    try{
      const body=req.body||{}; const roleIds=body.role_ids;
      const users=await db.listAdminUsers();
      // Out-of-scope target → 404 (never 403), so a Trailer Manager cannot infer
      // that a super admin or unrelated account exists.
      const target=scope.resolveTargetOr404(req,users,req.params.id);
      if(Array.isArray(roleIds))await validateAssignableRoles(req,roleIds);
      // The last active super administrator cannot be deactivated or demoted.
      scope.assertSuperAdminFloor(users,target,{nextRoleIds:roleIds,nextActive:body.active});
      const passwordHash=body.password?await bcrypt.hash(String(body.password),12):null;
      if(body.password&&String(body.password).length<10)return res.status(400).json({error:'Password must be at least 10 characters.'});
      const user=await db.updateAdminUser(req.params.id,{username:body.username,active:body.active,roleIds,passwordHash,actorId:req.admin.id});
      res.json({user});
    }catch(e){res.status(status(e)).json({error:e.status?e.message:'Could not update user.'});}
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
