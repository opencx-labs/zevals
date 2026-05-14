import FastifyBearerAuthPlugin from '@fastify/bearer-auth';
import FastifySwaggerPlugin from '@fastify/swagger';
import FastifySwaggerUIPlugin from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyRequest } from 'fastify';
import { buildRetailDB, DB, OrdersSchema, UserSchema } from './data/db';
import { scenarios } from './data/trajectories';
import * as tools from './tools';
import { cancelPendingOrderTool } from './tools/cancel-pending-order';
import {
  ExchangeDeliveredOrderItemsInput,
  exchangeDeliveredOrderItemsTool,
} from './tools/exchange-delivered-order-items';
import { FindUserIdByEmailInput, findUserIdByEmailTool } from './tools/find-user-id-by-email';
import {
  FindUserIdByNameZipInput,
  findUserIdByNameZipTool,
} from './tools/find-user-id-by-name-zip';
import { GetOrderDetailsInput, getOrderDetailsTool } from './tools/get-order-details';
import { GetProductDetailsInput, getProductDetailsTool } from './tools/get-product-details';
import { GetUserDetailsInput, getUserDetailsTool } from './tools/get-user-details';
import { listAllProductTypesTool } from './tools/list-all-product-types';
import {
  ModifyPendingOrderAddressInput,
  modifyPendingOrderAddressTool,
} from './tools/modify-pending-order-address';
import {
  ModifyPendingOrderItemsInput,
  modifyPendingOrderItemsTool,
} from './tools/modify-pending-order-items';
import {
  ModifyPendingOrderPaymentInput,
  modifyPendingOrderPaymentTool,
} from './tools/modify-pending-order-payment';
import { ModifyUserAddressInput, modifyUserAddressTool } from './tools/modify-user-address';
import {
  ReturnDeliveredOrderItemsInput,
  returnDeliveredOrderItemsTool,
} from './tools/return-delivered-order-items';

export async function policy() {
  return fetch(
    'https://raw.githubusercontent.com/sierra-research/tau-bench/14bf0ef52e595922d597a38f32d3e8c0dce3a8f8/tau_bench/envs/retail/wiki.md',
  ).then((res) => res.text());
}

export { scenarios, tools };

function getRootFastify() {
  return Fastify().withTypeProvider<TypeBoxTypeProvider>();
}

export async function serve({
  port = 5552,
  auth,
}: {
  port?: number;
  auth?: { validateToken: (token: string) => boolean; header?: string };
}) {
  const rootFastify = getRootFastify();

  await rootFastify.register(FastifySwaggerPlugin, {
    exposeHeadRoutes: false,
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Tau-Bench Retail API',
        description:
          'API for Tau-Bench Retail, providing access to products, categories, brands, orders, and customers',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          Bearer: {
            type: 'http',
            scheme: 'bearer',
          },
          Tenant: {
            type: 'apiKey',
            in: 'header',
            name: 'x-tenant-id',
          },
        },
      },
      security: [{ Bearer: [], Tenant: [] }],
      servers: [
        {
          url: `http://localhost:${port}`,
        },
      ],
    },
  });

  await rootFastify.register(FastifySwaggerUIPlugin, {
    routePrefix: '/docs',
  });

  let dbContext: ReturnType<typeof privateRoutes>;
  if (auth) {
    rootFastify.register(async (fastify) => {
      fastify.register(FastifyBearerAuthPlugin, {
        keys: new Set([auth.header ?? 'authorizatiion']),
        auth: auth.validateToken,
      });

      dbContext = privateRoutes(fastify);
    });
  } else {
    dbContext = privateRoutes(rootFastify);
  }

  // Listen on port
  rootFastify.listen({ port }, (err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Tau-Bench Retail Server docs at http://localhost:${port}/docs`);
  });

  await rootFastify.ready();

  return { server: rootFastify, ...dbContext! };
}

function getTenantId(request: FastifyRequest) {
  const tenantId = request.headers['x-tenant-id'] as string;
  if (!tenantId) {
    return 'default';
  }

  return tenantId;
}

function privateRoutes(fastify: ReturnType<typeof getRootFastify>) {
  const dbsByTenantId = new Map<string, Awaited<ReturnType<typeof buildRetailDB>>>();

  async function getDB(tenantId: string): Promise<DB> {
    if (!dbsByTenantId.has(tenantId)) {
      dbsByTenantId.set(tenantId, await buildRetailDB());
    }
    return dbsByTenantId.get(tenantId)!;
  }

  fastify.post(
    '/cancel-pending-order',
    {
      schema: {
        operationId: 'cancel_pending_order',
        description:
          "Cancel a pending order. If the order is already processed or delivered, it cannot be cancelled. The agent needs to explain the cancellation detail and ask for explicit user confirmation (yes/no) to proceed. If the user confirms, the order status will be changed to 'cancelled' and the payment will be refunded. The refund will be added to the user's gift card balance immediately if the payment was made using a gift card, otherwise the refund would take 5-7 business days to process. The function returns the order details after the cancellation.",
        body: Type.Object({
          order_id: Type.String({
            description:
              "The order id, such as '#W0000000'. Be careful there is a '#' symbol at the beginning of the order id.",
          }),
          reason: Type.Union(
            [Type.Literal('no longer needed'), Type.Literal('ordered by mistake')],
            {
              description:
                "The reason for cancellation, which should be either 'no longer needed' or 'ordered by mistake'.",
            },
          ),
        }),
        response: {
          200: OrdersSchema,
          400: Type.Object({
            error: Type.String(),
          }),
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.body;
      const result = await cancelPendingOrderTool.invoke(input, db);
      if (!result.success) {
        if (result.status === 400) {
          return reply.status(400).send({ error: result.message });
        }
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.post(
    '/exchange-delivered-order-items',
    {
      schema: {
        operationId: 'exchange_delivered_order_items',
        description:
          'Exchange items in a delivered order to new items of the same product type. For a delivered order, return or exchange can be only done once by the agent. The agent needs to explain the exchange detail and ask for explicit user confirmation (yes/no) to proceed.',
        body: ExchangeDeliveredOrderItemsInput,
        response: {
          200: OrdersSchema,
          400: Type.Object({
            error: Type.String(),
          }),
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.body;
      const result = await exchangeDeliveredOrderItemsTool.invoke(input, db);
      if (!result.success) {
        if (result.status === 400) {
          return reply.status(400).send({ error: result.message });
        }
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.get(
    '/find-user-id-by-email',
    {
      schema: {
        operationId: 'find_user_id_by_email',
        description:
          'Find user id by email. If the user is not found, the function will return an error message.',
        querystring: FindUserIdByEmailInput,
        response: {
          200: Type.Object({
            user_id: Type.String(),
          }),
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.query;
      const result = await findUserIdByEmailTool.invoke(input, db);
      if (!result.success) {
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.get(
    '/find-user-id-by-name-zip',
    {
      schema: {
        operationId: 'find_user_id_by_name_zip',
        description:
          'Find user id by first name, last name, and zip code. If the user is not found, the function will return an error message. By default, find user id by email, and only call this function if the user is not found by email or cannot remember email.',
        querystring: FindUserIdByNameZipInput,
        response: {
          200: Type.Object({
            user_id: Type.String(),
          }),
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.query;
      const result = await findUserIdByNameZipTool.invoke(input, db);
      if (!result.success) {
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.get(
    '/get-order-details',
    {
      schema: {
        operationId: 'get_order_details',
        description: 'Get the status and details of an order.',
        querystring: GetOrderDetailsInput,
        response: {
          200: OrdersSchema,
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.query;
      const result = await getOrderDetailsTool.invoke(input, db);
      if (!result.success) {
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.get(
    '/get-product-details',
    {
      schema: {
        operationId: 'get_product_details',
        description: 'Get the inventory details of a product.',
        querystring: GetProductDetailsInput,
        response: {
          200: getProductDetailsTool.outputSchema,
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.query;
      const result = await getProductDetailsTool.invoke(input, db);
      if (!result.success) {
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.get(
    '/get-user-details',
    {
      schema: {
        operationId: 'get_user_details',
        description: 'Get the details of a user, including their orders.',
        querystring: GetUserDetailsInput,
        response: {
          200: getUserDetailsTool.outputSchema,
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.query;
      const result = await getUserDetailsTool.invoke(input, db);
      if (!result.success) {
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.get(
    '/list-all-product-types',
    {
      schema: {
        operationId: 'list_all_product_types',
        description:
          'List the name and product id of all product types. Each product type has a variety of different items with unique item ids and options. There are only 50 product types in the store.',
        response: {
          200: Type.Record(Type.String(), Type.String()),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const result = await listAllProductTypesTool.invoke({}, db);
      if (!result.success) {
        return reply.send({});
      }
      return reply.send(result.output.result);
    },
  );

  fastify.post(
    '/modify-pending-order-address',
    {
      schema: {
        operationId: 'modify_pending_order_address',
        description:
          'Modify the shipping address of a pending order. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed.',
        body: ModifyPendingOrderAddressInput,
        response: {
          200: OrdersSchema,
          400: Type.Object({
            error: Type.String(),
          }),
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.body;
      const result = await modifyPendingOrderAddressTool.invoke(input, db);
      if (!result.success) {
        if (result.status === 400) {
          return reply.status(400).send({ error: result.message });
        }
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.post(
    '/modify-pending-order-items',
    {
      schema: {
        operationId: 'modify_pending_order_items',
        description:
          'Modify items in a pending order to new items of the same product type. For a pending order, this function can only be called once. The agent needs to explain the exchange detail and ask for explicit user confirmation (yes/no) to proceed.',
        body: ModifyPendingOrderItemsInput,
        response: {
          200: OrdersSchema,
          400: Type.Object({
            error: Type.String(),
          }),
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.body;
      const result = await modifyPendingOrderItemsTool.invoke(input, db);
      if (!result.success) {
        if (result.status === 400) {
          return reply.status(400).send({ error: result.message });
        }
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.post(
    '/modify-pending-order-payment',
    {
      schema: {
        operationId: 'modify_pending_order_payment',
        description:
          'Modify the payment method of a pending order. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed.',
        body: ModifyPendingOrderPaymentInput,
        response: {
          200: OrdersSchema,
          400: Type.Object({
            error: Type.String(),
          }),
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.body;
      const result = await modifyPendingOrderPaymentTool.invoke(input, db);
      if (!result.success) {
        if (result.status === 400) {
          return reply.status(400).send({ error: result.message });
        }
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.post(
    '/modify-user-address',
    {
      schema: {
        operationId: 'modify_user_address',
        description:
          'Modify the default address of a user. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed.',
        body: ModifyUserAddressInput,
        response: {
          200: UserSchema,
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.body;
      const result = await modifyUserAddressTool.invoke(input, db);
      if (!result.success) {
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  fastify.post(
    '/return-delivered-order-items',
    {
      schema: {
        operationId: 'return_delivered_order_items',
        description:
          "Return some items of a delivered order. The order status will be changed to 'return requested'. The agent needs to explain the return detail and ask for explicit user confirmation (yes/no) to proceed. The user will receive follow-up email for how and where to return the item.",
        body: ReturnDeliveredOrderItemsInput,
        response: {
          200: OrdersSchema,
          400: Type.Object({
            error: Type.String(),
          }),
          404: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const db = await getDB(tenantId);
      const input = request.body;
      const result = await returnDeliveredOrderItemsTool.invoke(input, db);
      if (!result.success) {
        if (result.status === 400) {
          return reply.status(400).send({ error: result.message });
        }
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result.output);
    },
  );

  return { dbsByTenantId, getDB };
}
