
const { PrismaClient } = require('@prisma/client');
const { getRedisConnectionOptions } = require('./test_config');
const prisma = new PrismaClient();

async function testProjectWorkflow() {
    const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ?si=test1234";
    const userId = "00000000-0000-0000-0000-000000000001";

    console.log("--- Starting Test Workflow ---");

    try {
        // 1. Create Project
        console.log("1. Creating project...");
        const project = await prisma.project.create({
            data: {
                userId,
                title: "Test Project Debug",
                youtubeUrl,
                visualStyle: "cinematic",
                aspectRatio: "16:9",
                status: "DRAFT"
            }
        });
        console.log("Project created:", project.id);

        // 2. Simulate Start Generation (roughly what JobsService.startPipeline does)
        console.log("2. Simulating startGeneration...");
        // We can't easily call NestJS services from here, but we can check if the logic would fail
        // JobsService uses BullMQ. Let's check if we can connect to Redis/BullMQ.

        const { Queue } = require('bullmq');
        const IORedis = require('ioredis');
        const redisConnection = getRedisConnectionOptions();
        const redis =
            redisConnection.url
                ? new IORedis(redisConnection.url, { maxRetriesPerRequest: null })
                : new IORedis({ ...redisConnection, maxRetriesPerRequest: null });

        try {
            await redis.ping();
            console.log("Redis connected successfully.");

            const youtubeDownloadQueue = new Queue('youtube-download', { connection: redis });
            await youtubeDownloadQueue.add('process', { projectId: project.id });
            console.log("Job added to youtube-download queue.");

        } catch (redisError) {
            console.error("Error connecting to Redis or BullMQ:", redisError.message);
            throw redisError;
        } finally {
            await redis.disconnect();
        }

        console.log("--- Test Workflow Completed Successfully ---");
    } catch (error) {
        console.error("--- Test Workflow Failed ---");
        console.error(error);
    } finally {
        await prisma.$disconnect();
    }
}

testProjectWorkflow();
