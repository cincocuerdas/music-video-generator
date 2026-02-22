const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const userId = '00000000-0000-0000-0000-000000000001';
    console.log(`Seeding default user: ${userId}`);

    const user = await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: {
            id: userId,
            email: 'default@example.com',
            name: 'Default User',
        },
    });

    console.log('User seeded:', user);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
