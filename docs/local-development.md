# Local development lifecycle

Run `npm run db:generate` before starting the web UI or worker. Stop only the npm process trees that you started before regenerating Prisma; never terminate processes by executable name. The root `npm run dev` command performs generation first.
