import { z } from "zod"

import { VENDOR_BUSINESS_CATEGORIES } from "../types/vendor.js"

const optionalUrl = z
  .union([z.string().trim().url("Enter a valid URL.").max(300), z.literal("")])
  .optional()
  .transform((value) => (value ? value : null))

const businessDetailsShape = {
  businessName: z
    .string()
    .trim()
    .min(2, "Business name must be at least 2 characters.")
    .max(120, "Business name must be 120 characters or fewer."),
  category: z.enum(VENDOR_BUSINESS_CATEGORIES, {
    message: "Choose a valid business category.",
  }),
  phone: z
    .string()
    .trim()
    .min(6, "Enter a contact phone number.")
    .max(25, "Phone number must be 25 characters or fewer.")
    .regex(/^[+()\d\s-]+$/, "Enter a valid phone number."),
  location: z
    .string()
    .trim()
    .min(2, "Enter your business location.")
    .max(180, "Location must be 180 characters or fewer."),
  website: optionalUrl,
  description: z
    .string()
    .trim()
    .min(20, "Describe your business in at least 20 characters.")
    .max(2000, "Description must be 2,000 characters or fewer."),
}

export const vendorBusinessDetailsSchema = z.object(businessDetailsShape)

export const vendorProfileUpdateSchema = z.object(businessDetailsShape)

export const vendorRegistrationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Enter your full name.")
    .max(80, "Name must be 80 characters or fewer."),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z
    .string()
    .min(8, "Use at least 8 characters.")
    .max(128, "Password must be 128 characters or fewer.")
    .regex(/[a-zA-Z]/, "Include at least one letter.")
    .regex(/\d/, "Include at least one number."),
  image: z
    .union([z.string().trim().url("Enter a valid image URL.").max(500), z.literal("")])
    .optional()
    .transform((value) => (value ? value : undefined)),
  ...businessDetailsShape,
})

export const vendorServiceSchema = z.object({
  serviceName: z
    .string()
    .trim()
    .min(3, "Service name must be at least 3 characters.")
    .max(120, "Service name must be 120 characters or fewer."),
  category: z.enum(VENDOR_BUSINESS_CATEGORIES, {
    message: "Choose a valid service category.",
  }),
  description: z
    .string()
    .trim()
    .min(20, "Describe the service in at least 20 characters.")
    .max(2000, "Description must be 2,000 characters or fewer."),
  price: z.coerce
    .number()
    .finite("Enter a valid price.")
    .min(0, "Price cannot be negative.")
    .max(10_000_000, "Price is too large."),
  location: z
    .string()
    .trim()
    .min(2, "Enter the service location.")
    .max(180, "Location must be 180 characters or fewer."),
  images: z
    .array(z.string().trim().url("Each image must be a valid URL.").max(500))
    .min(1, "Add at least one image URL.")
    .max(8, "Add no more than 8 images."),
})

export const vendorServiceUpdateSchema = vendorServiceSchema

export const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, "Invalid record ID.")

export type VendorRegistrationInput = z.infer<typeof vendorRegistrationSchema>
export type VendorProfileUpdateInput = z.infer<typeof vendorProfileUpdateSchema>
export type VendorServiceInput = z.infer<typeof vendorServiceSchema>
