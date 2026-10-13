import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;
