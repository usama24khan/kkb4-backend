import { Response } from 'express';

interface ApiResponse {
  success: boolean;
  data?: any;
  message: string;
  error?: string;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}

export const sendSuccess = (res: Response, data: any, message: string = 'Success', statusCode: number = 200, meta?: any): void => {
  const response: ApiResponse = { success: true, data, message };
  if (meta) response.meta = meta;
  res.status(statusCode).json(response);
};

export const sendError = (res: Response, message: string, statusCode: number = 500, error?: string): void => {
  const response: ApiResponse = { success: false, message, error };
  res.status(statusCode).json(response);
};

export const sendPaginated = (
  res: Response,
  data: any[],
  total: number,
  page: number,
  limit: number,
  message: string = 'Success'
): void => {
  res.status(200).json({
    success: true,
    data,
    message,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};
