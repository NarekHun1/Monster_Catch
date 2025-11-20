-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dailyCatch1000ClaimAt" TIMESTAMP(3),
ADD COLUMN     "dailyEpic100ClaimAt" TIMESTAMP(3),
ADD COLUMN     "dailyPlay3ClaimAt" TIMESTAMP(3);
