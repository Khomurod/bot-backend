import React,{createContext,useContext}from'react';
const AuthContext=createContext({user:null,permissions:[],roles:[]});
export function AuthProvider({session,children}){return <AuthContext.Provider value={{user:session?.user||null,permissions:session?.permissions||[],roles:session?.roles||[]}}>{children}</AuthContext.Provider>}
export function useAuth(){const value=useContext(AuthContext);return{...value,can:(...keys)=>keys.some((key)=>value.permissions.includes(key)),isSuperAdmin:value.permissions.includes('admin.full_access')}}
