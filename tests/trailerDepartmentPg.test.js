'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const crypto=require('node:crypto');const bcrypt=require('bcryptjs');const{Pool}=require('pg');
const url=process.env.TEST_DATABASE_URL;const section=fs.readFileSync(require.resolve('../database/schema.sql'),'utf8').split('-- TRAILER DEPARTMENT: RENTAL + ASSET MANAGEMENT')[1];

test('trailer department migration reruns, seeds safely, and rejects rental overlap',{skip:!url?'set TEST_DATABASE_URL':false,timeout:30000},async(t)=>{
  const pool=new Pool({connectionString:url,max:4});const schema=`td_${crypto.randomBytes(6).toString('hex')}`;const adminHash=await bcrypt.hash('preserve-me',4);
  t.after(async()=>{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end()});
  const client=await pool.connect();
  try{
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema},public`);
    await client.query(`CREATE TABLE admins(id SERIAL PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE trailers(id SERIAL PRIMARY KEY,unit_number TEXT UNIQUE NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE,needs_review BOOLEAN NOT NULL DEFAULT FALSE,source TEXT NOT NULL DEFAULT 'admin_manual',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE trailer_events(id BIGSERIAL PRIMARY KEY);
      CREATE TABLE trailer_settings(id INTEGER PRIMARY KEY,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      INSERT INTO trailer_settings(id)VALUES(1);INSERT INTO admins(username,password_hash)VALUES('existing',$1)`,[adminHash]);
    await client.query(section);await client.query(section);
    const existing=await client.query(`SELECT a.password_hash,r.system_key FROM admins a JOIN admin_user_roles aur ON aur.admin_id=a.id JOIN roles r ON r.id=aur.role_id WHERE a.username='existing'`);
    assert.equal(existing.rows[0].password_hash,adminHash);assert.equal(existing.rows[0].system_key,'super_admin');
    const trailerLogin=await client.query(`SELECT a.password_hash,r.system_key FROM admins a JOIN admin_user_roles aur ON aur.admin_id=a.id JOIN roles r ON r.id=aur.role_id WHERE a.username='Trailer'`);
    assert.equal(await bcrypt.compare('Trailer123',trailerLogin.rows[0].password_hash),true);assert.equal(trailerLogin.rows[0].system_key,'trailer_manager');
    await client.query(`UPDATE admins SET password_hash='changed' WHERE username='Trailer'`);await client.query(section);
    assert.equal((await client.query(`SELECT password_hash FROM admins WHERE username='Trailer'`)).rows[0].password_hash,'changed');
    const ids=await client.query(`INSERT INTO trailers(unit_number,physical_status,needs_review)VALUES('T-1','available',FALSE)RETURNING id`);const company=await client.query(`INSERT INTO trailer_renter_companies(legal_name,display_name)VALUES('Acme LLC','Acme')RETURNING id`);
    const insert=`INSERT INTO ${schema}.trailer_rentals(agreement_number,trailer_id,company_id,status,start_at,expected_return_at,daily_rate)VALUES($1,$2,$3,'scheduled','2026-01-01','2026-01-10',100)`;
    const a=pool.connect(),b=pool.connect();const[c1,c2]=await Promise.all([a,b]);
    try{const results=await Promise.allSettled([c1.query(insert,['RENT-2026-000001',ids.rows[0].id,company.rows[0].id]),c2.query(insert,['RENT-2026-000002',ids.rows[0].id,company.rows[0].id])]);assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);assert.equal(results.find((r)=>r.status==='rejected').reason.code,'23P01');}finally{c1.release();c2.release();}
  }finally{client.release();}
});
