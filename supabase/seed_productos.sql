-- ============================================================
-- Opcional pero recomendado: precarga el catálogo con los 36
-- productos y costos reales que ya reconstruimos del 22-ago-2026.
-- Corre esto DESPUÉS de schema.sql (Project > SQL Editor > Run).
-- Puedes editar precios/costos después desde el panel de Admin.
-- ============================================================

insert into public.products (name, category, cost_price, sell_price) values
('Agua litro','Bebida',5.50,20.00),
('Agua mineral fresa-kiwi','Bebida',12.50,25.00),
('Agua mineral mango-naranja','Bebida',12.50,25.00),
('Banderilla','Comida preparada',10.50,25.00),
('Bigote chocolate','Pan dulce/Dulce',13.50,25.00),
('Café','Bebida',null,20.00),
('Cheetos colmillo','Botana salada',10.00,25.00),
('Chocorroles','Pan dulce/Dulce',18.50,25.00),
('Coca-cola','Bebida',19.00,30.00),
('Donas','Pan dulce/Dulce',18.50,25.00),
('Donas espolvoreadas','Pan dulce/Dulce',18.50,25.00),
('Doritos flaming hot','Botana salada',10.00,25.00),
('Gansito','Pan dulce/Dulce',15.00,25.00),
('Gatorade lima limón','Bebida',23.00,30.00),
('Gatorade mora azul','Bebida',23.00,30.00),
('Gatorade naranja','Bebida',23.00,30.00),
('Gatorade ponche','Bebida',23.00,30.00),
('Gatorade uva','Bebida',23.00,30.00),
('Mantecadas','Pan dulce/Dulce',18.50,25.00),
('Mini pizzas (orden 4)','Comida preparada',12.50,25.00),
('Nito','Pan dulce/Dulce',14.00,25.00),
('Panquecitos','Pan dulce/Dulce',18.00,25.00),
('Pinguinos','Pan dulce/Dulce',18.50,25.00),
('Powerade cítricos','Bebida',26.00,35.00),
('Powerade frutas','Bebida',26.00,35.00),
('Powerade lima limón','Bebida',26.00,35.00),
('Principe','Pan dulce/Dulce',20.00,25.00),
('Rebanada de pizza','Comida preparada',18.00,30.00),
('Rollo de pollo','Comida preparada',51.00,85.00),
('Sabritones picosos','Botana salada',10.00,25.00),
('Sabritones sal','Botana salada',10.00,25.00),
('Sandwich phily','Comida preparada',44.00,80.00),
('Sponch','Pan dulce/Dulce',18.50,25.00),
('Té pellegrino limón','Bebida',25.50,35.00),
('Té pelegrino naranja','Bebida',25.50,35.00),
('Trikitrakes','Botana salada',18.50,25.00)
on conflict (name) do nothing;
