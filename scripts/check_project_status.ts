
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const projectId = 'bbb35d85-c0d0-4bc0-b141-946696fe64bb';
    const project = await prisma.project.findUnique({
        where: { id: projectId },
    });
    console.log(JSON.stringify(project, null, 2));
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
