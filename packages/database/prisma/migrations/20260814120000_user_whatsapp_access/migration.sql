-- CreateTable
CREATE TABLE "user_whatsapp_instances" (
    "userId" TEXT NOT NULL,
    "whatsappInstanceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_whatsapp_instances_pkey" PRIMARY KEY ("userId","whatsappInstanceId")
);

-- CreateIndex
CREATE INDEX "user_whatsapp_instances_whatsappInstanceId_idx" ON "user_whatsapp_instances"("whatsappInstanceId");

-- AddForeignKey
ALTER TABLE "user_whatsapp_instances" ADD CONSTRAINT "user_whatsapp_instances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_whatsapp_instances" ADD CONSTRAINT "user_whatsapp_instances_whatsappInstanceId_fkey" FOREIGN KEY ("whatsappInstanceId") REFERENCES "whatsapp_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
