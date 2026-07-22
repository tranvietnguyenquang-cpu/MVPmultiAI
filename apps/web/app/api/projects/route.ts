import { NextResponse } from "next/server";
import { prisma } from "@project-relay/database";
import { validateWorkspace, inspectGit } from "@project-relay/execution";
import { initializeProjectMemory } from "@project-relay/project-memory";
import { createProjectSchema } from "@project-relay/shared";

export async function GET(){return NextResponse.json(await prisma.project.findMany({where:{archivedAt:null},orderBy:{updatedAt:"desc"}}));}
export async function POST(request:Request){
  try{const input=createProjectSchema.parse(await request.json());const repositoryPath=await validateWorkspace(input.repositoryPath);const git=await inspectGit(repositoryPath);const createdFiles=await initializeProjectMemory(repositoryPath);const project=await prisma.project.create({data:{name:input.name,repositoryPath,allowedCommands:input.commands,permittedPaths:[repositoryPath],auditEvents:{create:{actor:"local-user",action:"PROJECT_REGISTERED",details:{git,createdMemoryFiles:createdFiles}}}}});return NextResponse.json(project,{status:201});}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Invalid project."},{status:400});}
}
