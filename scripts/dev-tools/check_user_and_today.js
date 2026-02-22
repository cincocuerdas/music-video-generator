const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    // Check User
    const user = await prisma.user.findUnique({
        where: { id: '00000000-0000-0000-0000-000000000001' }
    });
    console.log('Default User:', user);

    // Check Projects from today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const projectsToday = await prisma.project.findMany({
        where: {
            createdAt: { gte: today }
        }
    });
    console.log('Projects created today:', projectsToday.length);
    if (projectsToday.length > 0) {
        console.log('Latest project:', projectsToday[projectsToday.length - 1]);
    }

    await prisma.$disconnect();
}

check();
