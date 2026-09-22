-- Productos nuevos detectados en el archivo de ventas del 19-sep-2026.
-- Los nombres coinciden exactamente con la columna "Artículo" del POS.

insert into public.products (name, category, cost_price, sell_price, active) values
('Pringles sal','Botana salada',14.00,30.00,true),
('Pringles nacho','Botana salada',14.00,30.00,true),
('Pringles crema y especias','Botana salada',14.00,30.00,true),
('Bimbuñuelos','Pan dulce/Dulce',16.91,25.00,true),
('M&m''s','Pan dulce/Dulce',16.00,35.00,true),
('Bolsa gomitas welchs','Pan dulce/Dulce',3.00,10.00,true),
('Chocolate Baileys','Pan dulce/Dulce',15.00,35.00,true),
('Snickers','Pan dulce/Dulce',16.00,35.00,true),
('Carlos V','Pan dulce/Dulce',8.00,20.00,true),
('Milky way','Pan dulce/Dulce',16.00,35.00,true)
on conflict (name) do update set
  category = excluded.category,
  cost_price = excluded.cost_price,
  sell_price = excluded.sell_price,
  active = true,
  updated_at = now();
