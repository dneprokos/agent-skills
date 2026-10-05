/** A second reader of process.env: the validated Config class is the only one this repo allows. */
export const BaseUrl = process.env.BASE_URL ?? "";
