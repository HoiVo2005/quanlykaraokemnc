import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(request: NextRequest) {
  try {
    const { roomSessionId, startTime: requestStartTime, endTime: requestEndTime, customerName, roomCost: requestRoomCost, totalPrice: requestTotalPrice } = await request.json();

    // Get room session with room and store details
    const session = await prisma.roomSession.findUnique({
      where: { Id: roomSessionId },
      include: { Room: true, Invoice: true },
    });

    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const room = session.Room;
    if (!room) {
      return Response.json({ error: 'Room not found' }, { status: 404 });
    }

    // Idempotency: nếu phiên đã có hóa đơn rồi thì trả về luôn, không tạo lại + không trừ kho lần nữa
    if (session.Invoice) {
      const existingItems = await prisma.orderItem.findMany({
        where: { RoomSessionId: roomSessionId },
      });
      return Response.json({
        ...session.Invoice,
        items: existingItems.map(item => ({
          id: item.Id,
          roomSessionId: item.RoomSessionId,
          productId: item.ProductId,
          productName: item.ProductName,
          price: Number(item.Price),
          quantity: item.Quantity,
          orderedAt: item.OrderedAt,
        })),
      });
    }

    // Get order items
    const items = await prisma.orderItem.findMany({
      where: { RoomSessionId: roomSessionId },
    });

    const startTime = requestStartTime ? new Date(requestStartTime) : session.StartTime;
    const endTime = requestEndTime ? new Date(requestEndTime) : new Date();

    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return Response.json({ error: 'Invalid start or end time' }, { status: 400 });
    }

    if (endTime.getTime() <= startTime.getTime()) {
      return Response.json({ error: 'End time must be after start time' }, { status: 400 });
    }

    const durationMinutes = Math.ceil((endTime.getTime() - startTime.getTime()) / (1000 * 60));
    const fallbackRoomCost = Math.ceil((durationMinutes * Number(room.PricePerHour)) / 60);
    const requestedRoomCost = Number(requestRoomCost);
    const roomCost = !isNaN(requestedRoomCost) ? requestedRoomCost : fallbackRoomCost;

    // Calculate items cost
    const itemsCost = items.reduce((total, item) => total + Number(item.Price) * item.Quantity, 0);
    const subtotal = roomCost + itemsCost;
    const requestedTotalPrice = Number(requestTotalPrice);
    const totalPrice = !isNaN(requestedTotalPrice) ? requestedTotalPrice : Math.ceil(subtotal / 1000) * 1000;

    // Thực hiện trong transaction để đảm bảo tính nhất quán dữ liệu
    // Gộp luôn việc trừ kho vào transaction để tránh trừ nhiều lần khi retry/mạng lỗi
    const [invoice] = await prisma.$transaction([
      prisma.invoice.create({
        data: {
          Id: Date.now().toString(),
          RoomSessionId: roomSessionId,
          CustomerName: customerName || 'Khách lẻ',
          StoreId: session.StoreId,
          RoomId: session.RoomId,
          StartTime: startTime,
          EndTime: endTime,
          RoomCost: roomCost,
          TotalPrice: totalPrice,
          Status: 'paid',
        },
      }),
      // Cập nhật trạng thái session
      prisma.roomSession.update({
        where: { Id: roomSessionId },
        data: { Status: 'completed' },
      }),
      // Đưa phòng về trạng thái trống
      prisma.room.update({
        where: { Id: session.RoomId },
        data: { Status: 'empty' },
      }),
      // Trừ kho cho từng món đã gọi
      ...items.map(item =>
        prisma.product.update({
          where: { Id: item.ProductId },
          data: { Quantity: { decrement: item.Quantity } },
        })
      ),
    ]);

    // Return invoice with items for display
    return Response.json({
      ...invoice,
      items: items.map(item => ({
        id: item.Id,
        roomSessionId: item.RoomSessionId,
        productId: item.ProductId,
        productName: item.ProductName,
        price: Number(item.Price),
        quantity: item.Quantity,
        orderedAt: item.OrderedAt,
      })),
    });
  } catch (error) {
    console.error('Invoice creation error:', error);
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const storeId = searchParams.get('storeId');
    const id = searchParams.get('id');
    const includeDeleted = searchParams.get('includeDeleted') === 'true';

    const invoices = await prisma.invoice.findMany({
      where: id ? { Id: id } : {
        ...(storeId ? { StoreId: storeId } : {}),
        ...(includeDeleted ? {} : { DeletedAt: null }),
      },
      include: {
        RoomSession: {
          include: {
            OrderItems: true,
            Room: true,
          },
        },
      },
      orderBy: { CreatedAt: 'desc' },
    });

    // Transform to match the expected format
    const transformedInvoices = invoices.map(invoice => ({
      id: invoice.Id,
      roomSessionId: invoice.RoomSessionId,
      customerName: invoice.CustomerName,
      storeId: invoice.StoreId,
      roomId: invoice.RoomId,
      roomNumber: (invoice.RoomSession?.Room as any)?.RoomNumber || (invoice.RoomSession?.Room as any)?.roomNumber || '',
      startTime: invoice.StartTime,
      endTime: invoice.EndTime,
      roomCost: Number(invoice.RoomCost),
      totalPrice: Number(invoice.TotalPrice),
      status: invoice.Status,
      createdAt: invoice.CreatedAt,
      updatedAt: invoice.UpdatedAt,
      // Thêm kiểm tra an toàn ở đây để tránh crash API
      items: (invoice.RoomSession?.OrderItems || []).map(item => ({
        id: item.Id,
        roomSessionId: item.RoomSessionId,
        productId: item.ProductId,
        productName: item.ProductName,
        price: Number(item.Price),
        quantity: item.Quantity,
        orderedAt: item.OrderedAt,
      })),
    }));

    // Nếu yêu cầu theo ID đơn lẻ, trả về object thay vì mảng
    if (id && transformedInvoices.length > 0) {
      return Response.json(transformedInvoices[0]);
    }

    return Response.json(transformedInvoices);
  } catch (error) {
    console.error('Invoice fetch error:', error);
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
}


export async function DELETE(request: NextRequest) {
  try {
    const { id, all, storeId, permanent } = await request.json();
    const now = new Date();

    if (all) {
      if (permanent) {
        await prisma.invoice.deleteMany({
          where: storeId && storeId !== 'all' ? { StoreId: storeId } : {}
        });
      } else {
        await prisma.invoice.updateMany({
          where: {
            ...(storeId && storeId !== 'all' ? { StoreId: storeId } : {}),
            DeletedAt: null
          },
          data: { DeletedAt: now }
        });
      }
      return Response.json({ success: true });
    }

    if (!id) {
      return Response.json({ error: 'ID hóa đơn là bắt buộc' }, { status: 400 });
    }

    if (permanent) {
      await prisma.invoice.delete({ where: { Id: id } });
    } else {
      await prisma.invoice.update({
        where: { Id: id },
        data: { DeletedAt: now }
      });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Invoice delete error:', error);
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
}
