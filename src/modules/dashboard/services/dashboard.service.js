const { query } = require('../../../config/database');

const getAnalytics = async (days = 30) => {
  const [sales, orderStats, lowStock, topProducts, salesGraph, recentOrders, lostSales, prevSales, operationsStats] = await Promise.all([
    // Total sales (delivered orders)
    query(`
      SELECT
        COALESCE(SUM(total_amount), 0) as total_sales,
        COUNT(*) as order_count
      FROM orders
      WHERE status IN ('delivered','shipped') AND created_at >= NOW() - INTERVAL '${days} days'
    `),

    // Orders grouped by status
    query(`
      SELECT status, COUNT(*) as count
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY status
      ORDER BY count DESC
    `),

    // Low stock products (using new stock table columns)
    query(`
      SELECT p.id, p.name, p.sku, p.min_stock_level,
        COALESCE(SUM(s.good_qty), 0) as current_stock
      FROM products p
      LEFT JOIN stock s ON p.id = s.product_id
      WHERE p.is_active = TRUE
      GROUP BY p.id, p.name, p.sku, p.min_stock_level
      HAVING COALESCE(SUM(s.good_qty), 0) <= p.min_stock_level
      ORDER BY COALESCE(SUM(s.good_qty), 0) ASC
      LIMIT 10
    `),

    // Top selling products
    query(`
      SELECT p.name, p.sku, SUM(oi.quantity) as units_sold, SUM(oi.line_total) as revenue
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status = 'delivered' AND o.created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY p.id, p.name, p.sku
      ORDER BY units_sold DESC
      LIMIT 5
    `),

    // Daily revenue graph
    query(`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(total_amount), 0) as revenue,
        COUNT(*) as orders
      FROM orders
      WHERE status IN ('delivered','shipped')
        AND created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `),

    // Recent orders
    query(`
      SELECT o.order_number, o.status, o.total_amount, o.created_at,
        o.order_source, c.name as customer_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      ORDER BY o.created_at DESC
      LIMIT 8
    `),

    // Lost sales (cancelled orders)
    query(`
      SELECT COALESCE(SUM(total_amount), 0) as lost_sales
      FROM orders
      WHERE status = 'cancelled' AND created_at >= NOW() - INTERVAL '${days} days'
    `),

    // Previous period for growth comparison
    query(`
      SELECT COALESCE(SUM(total_amount), 0) as prev_sales
      FROM orders
      WHERE status = 'delivered'
        AND created_at BETWEEN NOW() - INTERVAL '${days * 2} days' AND NOW() - INTERVAL '${days} days'
    `),

    // Operations stats
    query(`
      SELECT
        (SELECT COUNT(*) FROM purchase_requisitions WHERE status='pending') as pending_prs,
        (SELECT COUNT(*) FROM purchase_orders WHERE status='pending') as pending_pos,
        (SELECT COUNT(*) FROM inbounds WHERE status='in_progress') as active_inbounds,
        (SELECT COUNT(*) FROM inbounds WHERE status IN ('pending_stack','in_progress')) as pending_stacks,        
        (SELECT COUNT(*) FROM orders WHERE status='packaging') as packaging_orders,
        (SELECT COUNT(*) FROM damage_logs WHERE status='pending') as pending_damage
    `)
  ]);

  const currentSales = parseFloat(sales.rows[0].total_sales);
  const previousSales = parseFloat(prevSales.rows[0].prev_sales);
  const growth = previousSales > 0
    ? ((currentSales - previousSales) / previousSales * 100).toFixed(1)
    : 0;

  return {
    summary: {
      total_sales: currentSales,
      order_count: parseInt(sales.rows[0].order_count),
      lost_sales: parseFloat(lostSales.rows[0].lost_sales),
      growth_percent: parseFloat(growth.toString()),
      low_stock_count: lowStock.rows.length,
    },
    operations: operationsStats.rows[0],
    orders_by_status: orderStats.rows,
    low_stock_items: lowStock.rows,
    top_products: topProducts.rows,
    sales_graph: salesGraph.rows,
    recent_orders: recentOrders.rows,
  };
};

const getStockSummary = async () => {
  const result = await query(`
    SELECT
      COUNT(DISTINCT p.id) as total_products,
      COUNT(DISTINCT CASE WHEN COALESCE(s.good_qty, 0) = 0 THEN p.id END) as out_of_stock,
      COUNT(DISTINCT CASE WHEN COALESCE(s.good_qty, 0) > 0 AND COALESCE(s.good_qty, 0) <= p.min_stock_level THEN p.id END) as low_stock,
      COALESCE(SUM(p.purchase_price * COALESCE(s.good_qty, 0)), 0) as stock_value,
      COALESCE(SUM(s.damage_qty), 0) as total_damaged,
      COALESCE(SUM(s.expired_qty), 0) as total_expired,
      COALESCE(SUM(s.hold_qty), 0) as total_on_hold
    FROM products p
    LEFT JOIN stock s ON p.id = s.product_id
    WHERE p.is_active = TRUE
  `);
  return result.rows[0];
};

module.exports = { getAnalytics, getStockSummary };
