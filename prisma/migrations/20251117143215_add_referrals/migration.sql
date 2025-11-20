-- CreateTable
CREATE TABLE "Referral" (
    "id" SERIAL NOT NULL,
    "inviterId" INTEGER NOT NULL,
    "invitedId" INTEGER NOT NULL,
    "rewarded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Referral_inviterId_invitedId_key" ON "Referral"("inviterId", "invitedId");

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_invitedId_fkey" FOREIGN KEY ("invitedId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
