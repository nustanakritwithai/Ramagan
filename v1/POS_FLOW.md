# Mobile POS flow and stocktake photographs

The sales screens follow the user's four reference images, using Ramagan's own
products, lots and server-calculated prices. The implementation remains shared by
the website and Android wrapper.

1. **Catalog:** white product rows, green header, order ticket, search/filter and
   payment total. Each lot retains its identity and availability.
2. **Quantity:** tapping a product opens a decimal gram keypad. Cancel leaves the
   cart unchanged; confirm returns to the catalog and updates the order total.
3. **Order:** the ticket opens a review of quantities, line amounts and bill discount.
   Editing or removing a line updates the preview before payment.
4. **Payment:** cash, transfer or cash plus transfer. The split is one sale. Cash
   received and change are separate from revenue. A split requires both portions to
   be positive and to sum to the confirmed net, in integer satang.

The server remains authoritative for price, discount, stock, expiry, permissions,
documents and totals. A network timeout retains the original sale UUID and frozen
payload; the app reconciles that UUID before allowing a replacement transaction.
Old servers without the explicit split capability cannot accept split payments.

Stocktake submission shows any missing requirement beside the confirmation action.
Every selected lot needs a scale photograph, including equal system/count values
and a counted quantity of zero. Owner and Manager retain their existing permissions
to adjust immediately; Staff permissions do not change. The owner can inspect
photographs in private count history. Previous counts without photographs remain
marked as historical records without evidence.

A browser's camera chooser is a device hint. Neither the application nor an image
hash proves that a picture was freshly captured or that the scale weight is correct.
Photographs are supporting evidence for human inspection.

Source, fixture tests, CI builds and a live deployment are separate delivery states.
No successful unit test alone establishes that the installed Android application or
the original VPS has received this release.
