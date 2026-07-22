import { NextResponse } from "next/server"; import { prisma } from "@project-relay/database";
export async function POST(_:Request,{params}:{params:Promise<{id:string}>}){const {id}=await params;await prisma.project.update({where:{id},data:{archivedAt:new Date(),auditEvents:{create:{actor:"local-user",action:"PROJECT_ARCHIVED",details:{}}}}});return NextResponse.json({ok:true});}
