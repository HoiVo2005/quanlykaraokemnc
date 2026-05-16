import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const storeId = searchParams.get('storeId');
    const type = searchParams.get('type') || 'daily';
    const startParam = searchParams.get('startDate');
    const endParam = searchParams.get('endDate');

    if (!storeId) {
        return NextResponse.json({ error: 'Missing storeId' }, { status: 400 });
    }

    try {
        /* ───────────────────────────────────────────── */
        /* 1. TIME RANGE (FIX TIMEZONE)                  */
        /* ───────────────────────────────────────────── */

        const now = new Date();
        let startDate: Date;
        let endDate: Date;

        if (startParam) {
            startDate = new Date(startParam + 'T00:00:00.000Z');
            endDate = endParam
                ? new Date(endParam + 'T23:59:59.999Z')
                : new Date();
        } else {
            endDate = new Date();
            endDate.setHours(23, 59, 59, 999);

            startDate = new Date();

            if (type === 'daily') {
                startDate.setHours(0, 0, 0, 0);
            } else if (type === 'weekly') {
                const day = now.getDay();
                const diff = day === 0 ? -6 : 1 - day;
                startDate.setDate(now.getDate() + diff);
                startDate.setHours(0, 0, 0, 0);
            } else if (type === 'monthly') {
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            } else if (type === 'yearly') {
                startDate = new Date(now.getFullYear(), 0, 1);
            } else {
                startDate.setHours(0, 0, 0, 0);
            }
        }

        /* ───────────────────────────────────────────── */
        /* 2. PRODUCTS                                  */
        /* ───────────────────────────────────────────── */

        const products = await prisma.product.findMany({
            where: { StoreId: storeId },
        });

        /* ───────────────────────────────────────────── */
        /* 3. SALES FROM PAID INVOICES ONLY             */
        /* ───────────────────────────────────────────── */

        // Tìm các phiên phòng BẮT ĐẦU trong kỳ và ĐÃ THANH TOÁN (có hóa đơn)
        // Sử dụng StartTime thay vì CreatedAt của Invoice
        const sessionsInPeriod = await prisma.roomSession.findMany({
            where: {
                StoreId: storeId,
                StartTime: { gte: startDate, lte: endDate },
                // Chỉ tính những phòng đã chốt (tránh tính nhầm hàng đang dùng trong phòng chưa thanh toán vào báo cáo doanh thu/bán chạy)
                OR: [
                    { Status: 'completed' },
                    { Invoice: { Status: 'paid' } }
                ]
            },
            select: { Id: true, RoomId: true, StartTime: true },
        });
        const sessionIdsInPeriod = sessionsInPeriod.map(s => s.Id);
        const inRoomSessionIdsInPeriod = sessionsInPeriod.filter(s => s.RoomId !== 'EXTERNAL').map(s => s.Id);
        const takeawaySessionIdsInPeriod = sessionsInPeriod.filter(s => s.RoomId === 'EXTERNAL').map(s => s.Id);

        // Map sessionId -> startTime (để dựng breakdown theo ngày)
        const sessionTimeMap = new Map<string, Date>();
        const sessionRoomMap = new Map<string, string>();
        sessionsInPeriod.forEach(s => {
            sessionTimeMap.set(s.Id, s.StartTime as any);
            sessionRoomMap.set(s.Id, s.RoomId);
        });

        // Tương tự cho mốc tính tồn đầu
        const sessionsSinceStart = await prisma.roomSession.findMany({
            where: {
                StoreId: storeId,
                StartTime: { gte: startDate },
                OR: [
                    { Status: 'completed' },
                    { Invoice: { Status: 'paid' } }
                ]
            },
            select: { Id: true },
        });
        const sessionIdsSinceStart = sessionsSinceStart.map(s => s.Id);

        // Bán trong phòng (không tính EXTERNAL = mang về)
        const inRoomSalesInPeriod = await prisma.orderItem.groupBy({
            by: ['ProductId'],
            where: { RoomSessionId: { in: inRoomSessionIdsInPeriod } },
            _sum: { Quantity: true },
        });

        // Mang về/Tặng (RoomId='EXTERNAL')
        const takeawaySalesInPeriod = await prisma.orderItem.groupBy({
            by: ['ProductId'],
            where: { RoomSessionId: { in: takeawaySessionIdsInPeriod } },
            _sum: { Quantity: true },
        });

        // Bán từ mốc xem báo cáo đến hiện tại (giữ nguyên để tính tồn đầu)
        const salesSinceStart = await prisma.orderItem.groupBy({
            by: ['ProductId'],
            where: { RoomSessionId: { in: sessionIdsSinceStart } },
            _sum: { Quantity: true },
        });

        // Chi tiết từng OrderItem trong kỳ (để dựng breakdown theo ngày × sản phẩm)
        const orderItemsInPeriod = await prisma.orderItem.findMany({
            where: { RoomSessionId: { in: sessionIdsInPeriod } },
            select: {
                ProductId: true,
                Quantity: true,
                Price: true,
                RoomSessionId: true,
            },
        });

        /* ───────────────────────────────────────────── */
        /* 5. INVENTORY LOG                             */
        /* ───────────────────────────────────────────── */

        // Nhập trong kỳ
        const restocksInPeriod = await (prisma as any).inventoryLog.groupBy({
            by: ['ProductId'],
            where: {
                StoreId: storeId,
                CreatedAt: { gte: startDate, lte: endDate },
                Quantity: { gt: 0 },
            },
            _sum: { Quantity: true },
        });

        // Xuất lẻ trong kỳ
        const exportsInPeriod = await (prisma as any).inventoryLog.groupBy({
            by: ['ProductId'],
            where: {
                StoreId: storeId,
                CreatedAt: { gte: startDate, lte: endDate },
                Quantity: { lt: 0 },
                // Không tính các log mang về/tặng vì đã tính ở mục Sales (OrderItem)
                Type: { notIn: ['export', 'gift'] }
            },
            _sum: { Quantity: true },
        });

        // 🔥 QUAN TRỌNG: KHÔNG excludeInit ở đây

        // Nhập từ start → hiện tại
        const importSinceStart = await (prisma as any).inventoryLog.groupBy({
            by: ['ProductId'],
            where: {
                StoreId: storeId,
                CreatedAt: { gte: startDate },
                Quantity: { gt: 0 },
            },
            _sum: { Quantity: true },
        });

        // Xuất lẻ từ start → hiện tại
        const exportSinceStart = await (prisma as any).inventoryLog.groupBy({
            by: ['ProductId'],
            where: {
                StoreId: storeId,
                CreatedAt: { gte: startDate },
                Quantity: { lt: 0 },
                Type: { notIn: ['export', 'gift'] }
            },
            _sum: { Quantity: true },
        });

        /* ───────────────────────────────────────────── */
        /* 6. LOG LIST                                  */
        /* ───────────────────────────────────────────── */

        const logs = await (prisma as any).inventoryLog.findMany({
            where: {
                StoreId: storeId,
                CreatedAt: { gte: startDate, lte: endDate },
            },
            include: { product: true },
            orderBy: { CreatedAt: 'desc' },
        });

        /* ───────────────────────────────────────────── */
        /* 7. CALCULATE                                 */
        /* ───────────────────────────────────────────── */

        const safe = (n: any) => Number(n || 0);

        const stats = products.map(p => {
            // Bán trong phòng (không tính mang về)
            const inRoomRec = inRoomSalesInPeriod.find((s: any) => s.ProductId === p.Id);
            const inRoomSold = safe(inRoomRec?._sum?.Quantity);

            // Mang về (RoomId=EXTERNAL)
            const takeawayRec = takeawaySalesInPeriod.find((s: any) => s.ProductId === p.Id);
            const takeawayQty = safe(takeawayRec?._sum?.Quantity);

            // Hư hỏng / xuất lẻ khác (InventoryLog, không phải export/gift để tránh trùng)
            const exportPeriod = exportsInPeriod.find((e: any) => e.ProductId === p.Id);
            const damageQty = Math.abs(safe(exportPeriod?._sum?.Quantity));

            // Tổng "xuất khác": mang về + hư hỏng (Mang về đã bao gồm Tặng vì cả 2 đều dùng EXTERNAL)
            const otherExports = takeawayQty + damageQty;

            // Tổng số lượng giảm trong kỳ
            const totalDecrement = inRoomSold + otherExports;

            // Nhập trong kỳ
            const restockPeriod = restocksInPeriod.find((r: any) => r.ProductId === p.Id);
            const totalRestocked = safe(restockPeriod?._sum?.Quantity);

            // 🔥 TÍNH TỒN ĐẦU (CHUẨN)
            const importRec = importSinceStart.find((i: any) => i.ProductId === p.Id);
            const totalImportedSinceStart = safe(importRec?._sum?.Quantity);

            const exportRec = exportSinceStart.find((e: any) => e.ProductId === p.Id);
            const totalExportedSinceStart = Math.abs(safe(exportRec?._sum?.Quantity));

            const soldRec = salesSinceStart.find((s: any) => s.ProductId === p.Id);
            const totalSoldSinceStart = safe(soldRec?._sum?.Quantity);

            const openingStock =
                p.Quantity
                - totalImportedSinceStart
                + totalExportedSinceStart
                + totalSoldSinceStart;

            // Tổng (Tạo + Nhập) = Tồn đầu kỳ + Nhập trong kỳ
            const totalCreatedAndImported = Math.max(0, openingStock) + totalRestocked;

            // Số lượng còn lại = Tổng - Bán trong phòng - Xuất khác
            const closingStock = totalCreatedAndImported - totalDecrement;

            // Doanh thu trong kỳ = (Bán phòng + Mang về) × giá; hư hỏng không tính doanh thu
            const revenueQty = inRoomSold + takeawayQty;

            return {
                productId: p.Id,
                productName: p.Name,
                category: p.Category,
                openingStock: Math.max(0, openingStock),
                totalRestocked,
                totalCreatedAndImported,
                totalSold: inRoomSold,
                totalTakeaway: takeawayQty,
                totalDamage: damageQty,
                totalExported: otherExports,
                totalDecrement,
                totalRevenue: revenueQty * Number(p.Price || 0),
                currentStock: p.Quantity,
                closingStock: closingStock,
            };
        });

        /* ───────────────────────────────────────────── */
        /* 7b. DAILY BREAKDOWN (Sản lượng bán theo ngày) */
        /* ───────────────────────────────────────────── */

        const productMap = new Map(products.map(p => [p.Id, p] as const));
        type DayKey = string;
        const breakdownMap = new Map<string, {
            day: DayKey;
            productId: string;
            productName: string;
            category: string;
            inRoom: number;
            takeaway: number;
            revenue: number;
        }>();

        for (const oi of orderItemsInPeriod) {
            const startTime = sessionTimeMap.get(oi.RoomSessionId);
            if (!startTime) continue;
            const d = new Date(startTime);
            const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const isTakeaway = sessionRoomMap.get(oi.RoomSessionId) === 'EXTERNAL';
            const product = productMap.get(oi.ProductId);
            if (!product) continue;
            const key = `${day}__${oi.ProductId}`;
            let entry = breakdownMap.get(key);
            if (!entry) {
                entry = {
                    day,
                    productId: oi.ProductId,
                    productName: product.Name,
                    category: product.Category,
                    inRoom: 0,
                    takeaway: 0,
                    revenue: 0,
                };
                breakdownMap.set(key, entry);
            }
            const qty = Number(oi.Quantity || 0);
            if (isTakeaway) entry.takeaway += qty;
            else entry.inRoom += qty;
            entry.revenue += qty * Number(oi.Price || 0);
        }

        const dailyBreakdown = Array.from(breakdownMap.values()).sort((a, b) => {
            if (a.day !== b.day) return a.day < b.day ? 1 : -1;
            return a.productName.localeCompare(b.productName, 'vi');
        });

        /* ───────────────────────────────────────────── */
        /* 8. RESPONSE                                  */
        /* ───────────────────────────────────────────── */

        return NextResponse.json({
            stats,
            dailyBreakdown,
            logs: logs.map((l: any) => ({
                id: l.Id,
                productName: l.product?.Name || 'Sản phẩm đã xóa',
                quantity: l.Quantity,
                createdAt: l.CreatedAt,
                type: l.Type,
                note: l.Note,
            })),
            period: {
                startDate: startDate.toISOString(),
                endDate: endDate.toISOString(),
                type,
            },
        });

    } catch (error) {
        console.error('Inventory Stats API Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}