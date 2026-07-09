import { createCimisyHandler } from "cimisy/next";
import cimisyConfig from "@/cimisy.config";

export const { GET, POST, PUT, DELETE } = createCimisyHandler(cimisyConfig);
