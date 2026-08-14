import { UserFormPage } from "@/components/users/user-form";

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserFormPage userId={id} />;
}
