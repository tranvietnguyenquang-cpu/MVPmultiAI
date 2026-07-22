$ErrorActionPreference = "Stop"
$project = "projectrelay-validation"
docker compose -p $project -f docker-compose.yml -f docker-compose.validation.yml up -d
docker compose -p $project -f docker-compose.yml -f docker-compose.validation.yml ps

Write-Output "DATABASE_URL=postgresql://projectrelay:projectrelay@127.0.0.1:55432/projectrelay?schema=public"
Write-Output "REDIS_URL=redis://127.0.0.1:56379"
