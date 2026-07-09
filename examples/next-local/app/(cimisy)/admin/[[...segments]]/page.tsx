import { CimisyAdminPage } from "cimisy/next";
import cimisyConfig from "@/cimisy.config";

export default async function AdminPage({
  params,
}: {
  params: Promise<{ segments?: string[] }>;
}) {
  const { segments } = await params;
  return (
    <CimisyAdminPage
      cimisyConfig={cimisyConfig}
      segments={segments ?? []}
      basePath="/admin"
      apiBasePath="/api/cimisy"
    />
  );
}
