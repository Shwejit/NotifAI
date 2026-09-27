-- CreateEnum
CREATE TYPE "PreferenceChannel" AS ENUM ('IN_APP', 'EMAIL', 'WEB_PUSH', 'MOBILE_PUSH', 'SMS');

-- CreateEnum
CREATE TYPE "DigestFrequency" AS ENUM ('DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "DigestChannel" AS ENUM ('EMAIL');

-- AlterEnum
ALTER TYPE "DeliveryStatus" ADD VALUE 'SUPPRESSED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dndEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dndEndTime" TEXT,
ADD COLUMN     "dndStartTime" TEXT;

-- CreateTable
CREATE TABLE "Preference" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "channel" "PreferenceChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestPreference" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequency" "DigestFrequency" NOT NULL DEFAULT 'DAILY',
    "channel" "DigestChannel" NOT NULL DEFAULT 'EMAIL',
    "preferredTime" TEXT NOT NULL DEFAULT '09:00',
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DigestPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Preference_userId_idx" ON "Preference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Preference_userId_category_channel_key" ON "Preference"("userId", "category", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "DigestPreference_userId_key" ON "DigestPreference"("userId");

-- AddForeignKey
ALTER TABLE "Preference" ADD CONSTRAINT "Preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestPreference" ADD CONSTRAINT "DigestPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
