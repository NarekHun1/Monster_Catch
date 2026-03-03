-- CreateTable
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL,
    "telegramPaymentChargeId" TEXT NOT NULL,
    "providerPaymentChargeId" TEXT,
    "starsAmount" INTEGER NOT NULL,
    "coinsAmount" INTEGER NOT NULL,
    "payload" TEXT,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_telegramPaymentChargeId_key" ON "Payment"("telegramPaymentChargeId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
